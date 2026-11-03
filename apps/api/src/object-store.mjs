// Minimal S3-compatible object storage client (M2.2).
// Only the operations SyncCut needs (PUT / GET / HEAD / presigned GET),
// signed with AWS Signature Version 4 using node:crypto — deliberately no
// SDK dependency: the surface is four operations and SigV4 is stable.
// Works against AWS S3 and S3-compatible stores (MinIO, OSS/COS S3 modes).
import { createHash, createHmac } from "node:crypto";

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();

function signingKey(secretAccessKey, dateStamp, region) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function createObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey, region = "us-east-1", fetchImpl = fetch }) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("Object store endpoint, bucket and credentials are required");
  }
  const base = new URL(endpoint);
  const host = base.host;
  const pathFor = (key) => `${base.pathname.replace(/\/$/, "")}/${bucket}/${encodeKey(key)}`;

  function canonical({ method, key, now, extraHeaders = {}, payloadHash, query = "" }) {
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extraHeaders };
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join("");
    const canonicalRequest = [method, pathFor(key), query, canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(secretAccessKey, dateStamp, region)).update(stringToSign, "utf8").digest("hex");
    return { headers, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`, amzDate, dateStamp, scope, signature, signedNames };
  }

  async function request(method, key, { body = null, contentType = null } = {}) {
    const payloadHash = body ? sha256Hex(body) : sha256Hex("");
    const extra = contentType ? { "content-type": contentType } : {};
    const { headers, authorization } = canonical({ method, key, now: new Date(), extraHeaders: extra, payloadHash });
    const response = await fetchImpl(`${base.origin}${pathFor(key)}`, {
      method,
      headers: { ...headers, Authorization: authorization },
      body: body ?? undefined,
    });
    return response;
  }

  return {
    async put(key, bytes, { contentType = "application/octet-stream" } = {}) {
      const response = await request("PUT", key, { body: bytes, contentType });
      if (!response.ok) throw new Error(`Object store PUT failed with HTTP ${response.status}`);
      return { key, etag: response.headers.get("etag") ?? null };
    },
    async head(key) {
      const response = await request("HEAD", key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Object store HEAD failed with HTTP ${response.status}`);
      return { key, size: Number(response.headers.get("content-length") ?? 0), etag: response.headers.get("etag") ?? null };
    },
    async get(key) {
      const response = await request("GET", key);
      if (!response.ok) throw new Error(`Object store GET failed with HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    // Short-lived signed URL so a Mac agent can download without holding
    // store credentials (architecture: 短期下载签名 URL).
    presignGet(key, { ttlSeconds = 900 } = {}) {
      const now = new Date();
      const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const dateStamp = amzDate.slice(0, 8);
      const scope = `${dateStamp}/${region}/s3/aws4_request`;
      const queryParams = new URLSearchParams({
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${accessKeyId}/${scope}`,
        "X-Amz-Date": amzDate,
        "X-Amz-Expires": String(ttlSeconds),
        "X-Amz-SignedHeaders": "host",
      });
      const query = queryParams.toString();
      const canonicalRequest = ["GET", pathFor(key), query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
      const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
      const signature = createHmac("sha256", signingKey(secretAccessKey, dateStamp, region)).update(stringToSign, "utf8").digest("hex");
      return `${base.origin}${pathFor(key)}?${query}&X-Amz-Signature=${signature}`;
    },
  };
}
