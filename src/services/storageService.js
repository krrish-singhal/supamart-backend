// ONLY this file knows about Cloudinary. To migrate to Firebase Storage later,
// reimplement upload()/destroy()/url() with the same signatures — nothing else changes.

const cloudinary = require("cloudinary").v2;
const https = require("https");
const dns = require("dns");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Node.js v24+ sets https.globalAgent.timeout = 5 s. Cloudinary's upload API
// is hosted on AWS (high RTT from India) so 5 s is not enough to finish the
// TLS handshake. We also force IPv4 so that a stalled AAAA DNS query from
// systemd-resolved does not block the connection.
const cloudinaryAgent = new https.Agent({
  timeout: 60_000,
  keepAlive: false,
  lookup: (hostname, opts, cb) => dns.lookup(hostname, { ...opts, family: 4 }, cb),
});

// uploads a buffer, returns CDN url + public id
async function upload(buffer, folder = "products") {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", timeout: 60_000, agent: cloudinaryAgent },
      (err, result) => {
        if (err) {
          console.warn(`Cloudinary upload failed: ${err.message}. Falling back to base64 string.`);
          const base64Data = buffer.toString('base64');
          return resolve({
            url: `data:image/jpeg;base64,${base64Data}`,
            id: `local_${Date.now()}`
          });
        }
        resolve({ url: result.secure_url, id: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

async function destroy(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

// returns an optimized, width-constrained delivery url
function url(publicId, width = 400) {
  return cloudinary.url(publicId, {
    width,
    crop: "fill",
    quality: "auto",
    fetch_format: "auto",
  });
}

module.exports = { upload, destroy, url };
