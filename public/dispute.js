// BuzzCall vendor check-in (optional geolocation) and proof photo compression. No inline scripts needed.
(function () {
  'use strict';
  document.querySelectorAll('form[data-checkin-form]').forEach(function (form) {
    var sent = false;
    form.addEventListener('submit', function (ev) {
      if (sent || !navigator.geolocation) return;
      ev.preventDefault();
      var button = form.querySelector('button');
      if (button) button.disabled = true;
      var done = function () { sent = true; form.submit(); };
      var timer = setTimeout(done, 10000);
      navigator.geolocation.getCurrentPosition(function (pos) {
        clearTimeout(timer);
        form.elements.lat.value = pos.coords.latitude;
        form.elements.lng.value = pos.coords.longitude;
        form.elements.accuracy.value = Math.round(pos.coords.accuracy || 0);
        done();
      }, function () { clearTimeout(timer); done(); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  });
  document.querySelectorAll('form[data-proof-form]').forEach(function (form) {
    var input = form.querySelector('input[data-photo]');
    var hidden = form.elements.photo;
    var status = form.querySelector('[data-photo-status]');
    if (!input || !hidden) return;
    input.addEventListener('change', function () {
      hidden.value = '';
      var file = input.files && input.files[0];
      if (!file) return;
      if (status) status.textContent = 'Preparing photo...';
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var dims = [1280, 960, 720], quality = [0.72, 0.6, 0.5], out = '';
        for (var i = 0; i < dims.length; i++) {
          var scale = Math.min(1, dims[i] / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          out = c.toDataURL('image/jpeg', quality[i]);
          if (out.length < 880000) break;
        }
        URL.revokeObjectURL(url);
        if (out.length >= 880000) { if (status) status.textContent = 'That photo is too large. Try another one.'; return; }
        hidden.value = out;
        if (status) status.textContent = 'Photo ready to send.';
      };
      img.onerror = function () { if (status) status.textContent = 'That file could not be read as a photo.'; };
      img.src = url;
    });
  });
})();
