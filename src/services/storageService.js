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

// Signed upload via the Cloudinary SDK (api_key + api_secret).
function signedUpload(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", timeout: 60_000, agent: cloudinaryAgent },
      (err, result) => {
        if (err) return reject(err);
        resolve({ url: result.secure_url, id: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

// Unsigned upload via CLOUDINARY_UPLOAD_PRESET — used as a fallback when the API
// key's signed "create" permission is restricted (some Cloudinary security
// configurations block signed uploads from a given key while still allowing
// unsigned uploads through an explicit preset).
function unsignedUpload(buffer, folder) {
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!preset || !cloudName) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const boundary = `----supamart${Date.now()}`;
    const field = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const preamble =
      field("upload_preset", preset) +
      field("folder", folder) +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.png"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const body = Buffer.concat([
      Buffer.from(preamble, "utf8"),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);

    const req = https.request(
      {
        hostname: "api.cloudinary.com",
        path: `/v1_1/${cloudName}/image/upload`,
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
        timeout: 60_000,
        agent: cloudinaryAgent,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Unsigned upload returned ${res.statusCode}: ${data}`));
          }
          try {
            const json = JSON.parse(data);
            resolve({ url: json.secure_url, id: json.public_id });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// uploads a buffer, returns CDN url + public id
async function upload(buffer, folder = "products") {
  try {
    return await signedUpload(buffer, folder);
  } catch (err) {
    console.warn(`Cloudinary signed upload failed: ${err.message}. Trying unsigned preset upload.`);
  }

  try {
    const result = await unsignedUpload(buffer, folder);
    if (result) return result;
  } catch (err) {
    console.warn(`Cloudinary unsigned upload failed: ${err.message}. Falling back to base64 string.`);
  }

  console.warn("Cloudinary upload unavailable. Falling back to base64 string.");
  const base64Data = buffer.toString("base64");
  return {
    url: `data:image/jpeg;base64,${base64Data}`,
    id: `local_${Date.now()}`,
  };
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
