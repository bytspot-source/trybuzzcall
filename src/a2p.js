'use strict';
// Per-shop A2P 10DLC registration. Runs only when AUTO_A2P is on (default off).
// Low-Volume Standard (EIN): BrandType STANDARD + SkipAutomaticSecVet, campaign use case LOW_VOLUME.
// Sole Proprietor (no EIN): BrandType SOLE_PROPRIETOR, campaign use case SOLE_PROPRIETOR, OTP on the owner's mobile.
// Docs (see docs/GO_LIVE_ONBOARDING.md): Trust Hub ISV standard + sole-prop guides, BrandRegistrations, UsAppToPerson.
const vendors = require('./vendors');
const twilio = require('./twilioClient');
const shopContext = require('./shopContext');
const { data, save, a2pEnabled, redact, forgetEin, digits } = require('./onboardingStore');

// Published Trust Hub policy SIDs (not secrets). Twilio's ISV onboarding guides.
const POLICY = {
  secondaryProfile: 'RNdfbf3fae0e1107f8aded0e7cead80bf5',
  a2pProfile: 'RNb0d4771c2c98518d916a3d4cd70a8f8b',
  starterProfile: 'RN806dd6cd175f314e1f96a9727ee271f4',
  solePropProfile: 'RN670d5d2e282a6130ae063b234b6019c8',
};
const PRIMARY = () => (/^BU[0-9a-fA-F]{32}$/.test(process.env.TWILIO_PRIMARY_PROFILE_SID || '') ? process.env.TWILIO_PRIMARY_PROFILE_SID : '');

function industry(trade) {
  if (['plumbing', 'hvac', 'electrical', 'handyman', 'landscaping', 'cleaning'].includes(trade)) return 'CONSTRUCTION';
  if (trade === 'massage') return 'HEALTHCARE';
  if (trade === 'catering_bakery') return 'FOOD_AND_BEVERAGE';
  return 'PROFESSIONAL_SERVICES';
}
function vertical(trade) {
  const map = { CONSTRUCTION: 'CONSTRUCTION', HEALTHCARE: 'HEALTHCARE', FOOD_AND_BEVERAGE: 'RETAIL' };
  return map[industry(trade)] || 'PROFESSIONAL';
}
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Owner', last: 'Owner' };
  if (parts.length === 1) return { first: parts[0].slice(0, 40), last: parts[0].slice(0, 40) };
  return { first: parts[0].slice(0, 40), last: parts.slice(1).join(' ').slice(0, 40) };
}
function safeReason(brand, campaign) {
  const raw = brand?.failureReason || brand?.failure_reason
    || (Array.isArray(campaign?.errors) && (campaign.errors[0]?.description || campaign.errors[0]?.message))
    || '';
  return redact(raw).replace(/\s+/g, ' ').trim().slice(0, 300);
}
function reduceStatus(brand, campaign) {
  const b = String(brand?.status || '').toUpperCase();
  const c = String(campaign?.campaignStatus || campaign?.campaign_status || '').toUpperCase();
  const reason = safeReason(brand, campaign);
  if (b === 'FAILED' || b === 'SUSPENDED' || c === 'FAILED') return { status: 'rejected', reason: reason || 'The carrier rejected this registration.' };
  if (b === 'APPROVED' && c === 'VERIFIED') return { status: 'approved', reason: '' };
  if (b === 'APPROVED' && !c) return { status: 'in_review', reason: '' };
  if (b === 'IN_REVIEW' || c === 'IN_PROGRESS' || (b === 'APPROVED' && c && c !== 'VERIFIED')) return { status: 'in_review', reason: '' };
  return { status: 'pending', reason: '' };
}

async function inShop(shopId, fn) {
  if (shopContext.shopId() === shopId) return fn();
  return vendors.run(shopId, fn, { suspended: true });
}
function samplesFor(shopId) {
  return inShop(shopId, () => {
    const consent = require('./consent');
    const name = consent.shopName() || vendors.get(shopId)?.name || 'This shop';
    let first = '';
    try { first = require('./agent').firstMessage(); } catch { first = ''; }
    const help = consent.helpText(name);
    const stop = consent.stopText(name);
    const start = consent.startText(name);
    const voice = consent.voicePrompt(name);
    const list = [first, help].map((s) => String(s || '').trim()).filter((s) => s.length >= 20);
    if (list.length < 2) list.push(`${name}: Sorry we missed your call. Reply with your name and we will text you back. Reply STOP to opt out, HELP for help.`);
    return { name, voice, help, stop, start, samples: list.slice(0, 5), slug: require('./smsPage').slugify(name) };
  });
}
async function assign(collection, parentSid, objectSid, bag, key) {
  if (bag[key] || !objectSid) return;
  const created = await collection(parentSid).create({ objectSid });
  bag[key] = created && created.sid || 'done';
  save();
}
async function evaluateAndSubmit(evaluations, update, policySid) {
  const evaluation = await evaluations.create({ policySid });
  const status = String(evaluation && evaluation.status || '').toLowerCase();
  if (status && status !== 'compliant') {
    const err = new Error('Trust Hub evaluation was not compliant');
    err.safe = true;
    throw err;
  }
  await update({ status: 'pending-review' });
}

async function createProfile(client, rec, sole, email) {
  const bag = (rec.a2p.resources ||= {});
  const reg = rec.registration;
  const who = splitName(reg.contactName);
  if (!bag.customerProfileSid) {
    const profile = await client.trusthub.v1.customerProfiles.create({
      friendlyName: `${reg.legalName} customer profile`.slice(0, 64),
      email, policySid: sole ? POLICY.starterProfile : POLICY.secondaryProfile, status: 'draft',
    });
    bag.customerProfileSid = profile.sid;
    save();
  }
  const profileSid = bag.customerProfileSid;
  if (sole) {
    if (!bag.starterEndUserSid) {
      const end = await client.trusthub.v1.endUsers.create({
        friendlyName: `${reg.legalName} starter profile`.slice(0, 64),
        type: 'starter_customer_profile_information',
        attributes: { email, first_name: who.first, last_name: who.last, phone_number: reg.contactPhone },
      });
      bag.starterEndUserSid = end.sid;
      save();
    }
  } else if (!bag.businessEndUserSid) {
    const end = await client.trusthub.v1.endUsers.create({
      friendlyName: `${reg.legalName} business information`.slice(0, 64),
      type: 'customer_profile_business_information',
      attributes: {
        business_name: reg.legalName,
        business_identity: 'direct_customer',
        business_type: 'Corporation',
        business_industry: industry(rec.businessType),
        business_regions_of_operation: 'USA_AND_CANADA',
        business_registration_identifier: 'EIN',
        business_registration_number: digits(reg.ein),
        website_url: reg.website,
      },
    });
    bag.businessEndUserSid = end.sid;
    save();
  }
  if (!sole && !bag.repEndUserSid) {
    const end = await client.trusthub.v1.endUsers.create({
      friendlyName: `${reg.legalName} authorized rep`.slice(0, 64),
      type: 'authorized_representative_1',
      attributes: {
        first_name: who.first, last_name: who.last, email, phone_number: reg.contactPhone,
        business_title: 'Owner', job_position: 'Other',
      },
    });
    bag.repEndUserSid = end.sid;
    save();
  }
  if (!bag.addressSid) {
    const address = await client.addresses.create({
      customerName: reg.legalName.slice(0, 64), friendlyName: `${reg.legalName} address`.slice(0, 64),
      street: reg.street, city: reg.city, region: reg.region, postalCode: reg.postalCode, isoCountry: reg.country || 'US',
    });
    bag.addressSid = address.sid;
    save();
  }
  if (!bag.addressDocSid) {
    const doc = await client.trusthub.v1.supportingDocuments.create({
      friendlyName: `${reg.legalName} address document`.slice(0, 64),
      type: 'customer_profile_address',
      attributes: { address_sids: bag.addressSid },
    });
    bag.addressDocSid = doc.sid;
    save();
  }
  const assignments = client.trusthub.v1.customerProfiles(profileSid).customerProfilesEntityAssignments;
  await assign(() => assignments, profileSid, sole ? bag.starterEndUserSid : bag.businessEndUserSid, bag, 'assignBusiness');
  if (!sole) await assign(() => assignments, profileSid, bag.repEndUserSid, bag, 'assignRep');
  await assign(() => assignments, profileSid, bag.addressDocSid, bag, 'assignAddress');
  await assign(() => assignments, profileSid, PRIMARY(), bag, 'assignPrimary');
  if (!bag.profileSubmitted) {
    const profile = client.trusthub.v1.customerProfiles(profileSid);
    await evaluateAndSubmit(profile.customerProfilesEvaluations, (body) => profile.update(body), sole ? POLICY.starterProfile : POLICY.secondaryProfile);
    bag.profileSubmitted = true;
    save();
  }
  return profileSid;
}

async function createTrust(client, rec, sole, email, profileSid) {
  const bag = (rec.a2p.resources ||= {});
  const reg = rec.registration;
  if (!bag.trustSid) {
    const trust = await client.trusthub.v1.trustProducts.create({
      friendlyName: `${reg.legalName} A2P profile`.slice(0, 64),
      email, policySid: sole ? POLICY.solePropProfile : POLICY.a2pProfile,
    });
    bag.trustSid = trust.sid;
    save();
  }
  if (sole && !bag.soleEndUserSid) {
    const end = await client.trusthub.v1.endUsers.create({
      friendlyName: `${reg.legalName} sole proprietor`.slice(0, 64),
      type: 'sole_proprietor_information',
      attributes: { brand_name: reg.legalName.slice(0, 64), vertical: vertical(rec.businessType), mobile_phone_number: rec.phone },
    });
    bag.soleEndUserSid = end.sid;
    save();
  }
  if (!sole && !bag.messagingEndUserSid) {
    const end = await client.trusthub.v1.endUsers.create({
      friendlyName: `${reg.legalName} messaging profile`.slice(0, 64),
      type: 'us_a2p_messaging_profile_information',
      attributes: { company_type: 'private' },
    });
    bag.messagingEndUserSid = end.sid;
    save();
  }
  const assignments = client.trusthub.v1.trustProducts(bag.trustSid).trustProductsEntityAssignments;
  await assign(() => assignments, bag.trustSid, sole ? bag.soleEndUserSid : bag.messagingEndUserSid, bag, 'assignTrustEndUser');
  await assign(() => assignments, bag.trustSid, profileSid, bag, 'assignTrustProfile');
  if (!bag.trustSubmitted) {
    const trust = client.trusthub.v1.trustProducts(bag.trustSid);
    await evaluateAndSubmit(trust.trustProductsEvaluations, (body) => trust.update(body), sole ? POLICY.solePropProfile : POLICY.a2pProfile);
    bag.trustSubmitted = true;
    save();
  }
  return bag.trustSid;
}

async function createCampaign(client, rec, shopId, base) {
  const bag = rec.a2p.resources || {};
  if (rec.a2p.campaignSid) return rec.a2p.campaignSid;
  const root = String(base || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!rec.a2p.messagingServiceSid) {
    const service = await client.messaging.v1.services.create({
      friendlyName: `BuzzCall ${vendors.get(shopId)?.name || shopId}`.slice(0, 64),
      inboundRequestUrl: `${root}/twilio/sms`, inboundMethod: 'POST', useInboundWebhookOnNumber: true,
    });
    rec.a2p.messagingServiceSid = service.sid;
    save();
  }
  const copy = await samplesFor(shopId);
  const sole = rec.a2p.flow === 'sole_proprietor';
  const page = copy.slug ? `${root}/s/${copy.slug}/sms` : `${root}/sms-consent`;
  const hasLink = copy.samples.some((s) => /https?:\/\//i.test(s));
  const campaign = await client.messaging.v1.services(rec.a2p.messagingServiceSid).usAppToPerson.create({
    brandRegistrationSid: rec.a2p.brandSid,
    description: `${copy.name} missed-call text-back. Customers who call and press 1 get texts to book or request a callback. No marketing.`,
    messageFlow: `Customers opt in by calling ${copy.name}. If the call is missed they hear: "${copy.voice}" Only a press of 1 starts texts. The script and samples are published at ${page}. Consent is not required to buy anything. They can reply STOP to opt out or HELP for help.`,
    messageSamples: copy.samples,
    usAppToPersonUsecase: sole ? 'SOLE_PROPRIETOR' : 'LOW_VOLUME',
    hasEmbeddedLinks: hasLink, hasEmbeddedPhone: false,
    optInMessage: copy.start, optOutMessage: copy.stop, helpMessage: copy.help,
    optInKeywords: ['START', 'UNSTOP', 'YES'], optOutKeywords: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
    helpKeywords: ['HELP', 'INFO'], subscriberOptIn: true, ageGated: false, directLending: false,
    privacyPolicyUrl: `${root}/privacy`, termsAndConditionsUrl: `${root}/terms`,
  });
  rec.a2p.campaignSid = campaign.sid;
  if (rec.number?.sid && !bag.numberAttached) {
    await client.messaging.v1.services(rec.a2p.messagingServiceSid).phoneNumbers.create({ phoneNumberSid: rec.number.sid });
    bag.numberAttached = true;
  }
  save();
  return rec.a2p.campaignSid;
}

// Creates the brand once. Later calls only poll and, once the brand is approved, create the one campaign.
async function sync(shopId, base) {
  const rec = data().shops[shopId];
  if (!rec) return null;
  rec.a2p ||= { status: 'not_started' };
  if (!a2pEnabled()) {
    if (!rec.a2p.brandSid && rec.a2p.status !== 'approved' && rec.a2p.status !== 'rejected') rec.a2p.status = 'pending_admin';
    save();
    return rec.a2p;
  }
  if (rec.a2p.manual) return rec.a2p;
  const reg = rec.registration;
  if (!reg?.ready && !rec.a2p.brandSid) return rec.a2p;
  const primary = PRIMARY();
  if (!primary && !rec.a2p.brandSid) {
    rec.a2p.reason = 'BuzzCall primary Trust Hub profile is not set (TWILIO_PRIMARY_PROFILE_SID). Nothing was submitted.';
    const flags = new Set(rec.flags || []); flags.add('provisioning_failure'); rec.flags = [...flags];
    save();
    return rec.a2p;
  }
  const client = twilio.getClient();
  if (!client) {
    rec.a2p.reason = 'Twilio is not configured, so carrier registration was not submitted.';
    const flags = new Set(rec.flags || []); flags.add('provisioning_failure'); rec.flags = [...flags];
    save();
    return rec.a2p;
  }
  const sole = rec.a2p.flow === 'sole_proprietor' || (!rec.a2p.brandSid && !digits(reg?.ein));
  rec.a2p.flow = sole ? 'sole_proprietor' : 'low_volume_standard';
  try {
    if (!rec.a2p.brandSid) {
      const email = reg.contactEmail;
      const profileSid = await createProfile(client, rec, sole, email);
      const trustSid = await createTrust(client, rec, sole, email, profileSid);
      const brand = await client.messaging.v1.brandRegistrations.create(sole ? {
        customerProfileBundleSid: profileSid, a2PProfileBundleSid: trustSid, brandType: 'SOLE_PROPRIETOR',
      } : {
        customerProfileBundleSid: profileSid, a2PProfileBundleSid: trustSid, brandType: 'STANDARD', skipAutomaticSecVet: true,
      });
      rec.a2p.brandSid = brand.sid;
      forgetEin(reg); // the carrier has it; we keep the last four digits only
      const next = reduceStatus(brand, null);
      rec.a2p.status = next.status === 'approved' ? 'in_review' : next.status;
      rec.a2p.reason = next.reason;
      rec.a2p.updatedAt = new Date().toISOString();
      save();
    }
    let brand = null;
    try { brand = await client.messaging.v1.brandRegistrations(rec.a2p.brandSid).fetch(); } catch (e) {
      rec.a2p.reason = `Could not refresh brand status (${redact(e && e.message)}).`;
      save();
      return rec.a2p;
    }
    const brandStatus = String(brand?.status || '').toUpperCase();
    let campaign = null;
    if (brandStatus === 'APPROVED') {
      await createCampaign(client, rec, shopId, base);
      if (rec.a2p.campaignSid) {
        try { campaign = await client.messaging.v1.services(rec.a2p.messagingServiceSid).usAppToPerson(rec.a2p.campaignSid).fetch(); } catch { campaign = null; }
      }
    }
    if (rec.number?.sid && rec.a2p.messagingServiceSid && rec.a2p.resources && !rec.a2p.resources.numberAttached) {
      try {
        await client.messaging.v1.services(rec.a2p.messagingServiceSid).phoneNumbers.create({ phoneNumberSid: rec.number.sid });
        rec.a2p.resources.numberAttached = true;
      } catch (e) { rec.a2p.reason = `Could not attach the number (${redact(e && e.message)}).`; }
    }
    const next = reduceStatus(brand, campaign);
    rec.a2p.status = next.status;
    rec.a2p.reason = next.reason;
    rec.a2p.updatedAt = new Date().toISOString();
    if (next.status !== 'rejected') {
      const flags = new Set(rec.flags || []); flags.delete('provisioning_failure'); rec.flags = [...flags];
    }
    save();
    return rec.a2p;
  } catch (e) {
    rec.a2p.status = rec.a2p.brandSid ? rec.a2p.status : 'rejected';
    if (!rec.a2p.brandSid) rec.a2p.status = 'rejected';
    rec.a2p.reason = e && e.safe ? 'The carrier profile was not accepted. Check the legal name, address, website, and EIN.' : `Registration failed (${redact(e && e.message)}).`;
    rec.a2p.updatedAt = new Date().toISOString();
    const flags = new Set(rec.flags || []); flags.add('provisioning_failure'); rec.flags = [...flags];
    save();
    return rec.a2p;
  }
}

async function resendOtp(shopId) {
  const rec = data().shops[shopId];
  if (!rec?.a2p?.brandSid || rec.a2p.flow !== 'sole_proprietor') return { ok: false, error: 'No sole proprietor brand to verify.' };
  if (!a2pEnabled()) return { ok: false, error: 'Automatic registration is off.' };
  const sent = rec.a2p.otpSent || [];
  const recent = sent.filter((at) => Date.now() - Date.parse(at) < 86400000);
  if (recent.length >= 3) return { ok: false, error: 'The verification text was already resent 3 times today.' };
  const client = twilio.getClient();
  if (!client) return { ok: false, error: 'Twilio is not configured.' };
  await client.messaging.v1.brandRegistrations(rec.a2p.brandSid).brandRegistrationOtps.create();
  rec.a2p.otpSent = recent.concat(new Date().toISOString());
  save();
  return { ok: true };
}

module.exports = { sync, resendOtp, reduceStatus, POLICY };
