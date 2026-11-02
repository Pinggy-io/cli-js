"use strict";

// A stand-in for the dashboard's 2 jobs in a computer-use session: check the app's proof against the app
// key registered for the device, and sign a grant for 1 session on 1 connection.
// PoC shortcuts: the app registers its key by writing APP_KEY_INFO_PATH, and the app pins the
// dashboard's public key by reading DASHBOARD_PUBLIC_KEY_PATH. The real build registers the key at
// enrollment and ships the dashboard's key inside the app.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { POC_DIRECTORY } = require("./screenDaemon.cjs");

const SIGNING_KEY_PATH = path.join(POC_DIRECTORY, "dashboard", "grant-signing-key.pem");
const DASHBOARD_PUBLIC_KEY_PATH = path.join(POC_DIRECTORY, "dashboard-public.pem");
const APP_KEY_INFO_PATH = path.join(POC_DIRECTORY, "app-key.json");
const PROOF_CONTEXT = "pinggy-screen-proof-v1\n";
const GRANT_CONTEXT = "pinggy-screen-grant-v1\n";
const KEY_ID_HEX_LENGTH = 16;
const NONCE_BYTES = 32;
const GRANT_LIFETIME_SECONDS = 60;
const DEVICE_ID = "poc-device";
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

function dashboardError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function keyIdOf(publicKey) {
    const der = publicKey.export({ type: "spki", format: "der" });
    return crypto.createHash("sha256").update(der).digest("hex").slice(0, KEY_ID_HEX_LENGTH);
}

function createSigningKey() {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.mkdirSync(path.dirname(SIGNING_KEY_PATH), { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
    fs.writeFileSync(SIGNING_KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: OWNER_ONLY_FILE_MODE });
    return privateKey;
}

// Also writes the public key the app pins, so the app can check grants.
function loadSigningKey() {
    const signingKey = fs.existsSync(SIGNING_KEY_PATH)
        ? crypto.createPrivateKey(fs.readFileSync(SIGNING_KEY_PATH))
        : createSigningKey();
    const publicKeyPem = crypto.createPublicKey(signingKey).export({ type: "spki", format: "pem" });
    fs.writeFileSync(DASHBOARD_PUBLIC_KEY_PATH, publicKeyPem);
    return signingKey;
}

function registeredAppKey() {
    let appKeyInfo;
    try {
        appKeyInfo = JSON.parse(fs.readFileSync(APP_KEY_INFO_PATH, "utf-8"));
    } catch {
        throw dashboardError("app_key_missing", `no app key registered at ${APP_KEY_INFO_PATH}`);
    }
    const publicKey = crypto.createPublicKey(appKeyInfo.public_key_pem);
    if (keyIdOf(publicKey) !== appKeyInfo.app_key_id) throw dashboardError("app_key_missing", "app key id mismatch");
    return { appKeyId: appKeyInfo.app_key_id, publicKey };
}

function proofBytes(daemonNonce, appNonce) {
    return Buffer.from(`${PROOF_CONTEXT}${daemonNonce}\n${appNonce}`);
}

// Returns the app's identity, or throws proof_invalid.
function verifyProof(proof, daemonNonce) {
    const { appKeyId, publicKey } = registeredAppKey();
    if (proof.app_key_id !== appKeyId) throw dashboardError("proof_invalid", "not the registered app key");
    const signature = Buffer.from(String(proof.signature || ""), "base64");
    if (!crypto.verify(null, proofBytes(daemonNonce, String(proof.app_nonce)), publicKey, signature)) {
        throw dashboardError("proof_invalid", "bad proof signature");
    }
    return { app_key_id: appKeyId };
}

function signGrant(payload, signingKey) {
    const payloadText = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.sign(null, Buffer.from(GRANT_CONTEXT + payloadText), signingKey);
    return `${payloadText}.${signature.toString("base64url")}`;
}

// Checks the proof again rather than trusting the daemon's check, then signs.
// overrides lets a test forge or expire a grant.
function issueGrant(provider, session, overrides = {}) {
    verifyProof(provider.proof, provider.daemonNonce);
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const payload = {
        device_id: DEVICE_ID,
        app_key_id: provider.appKeyId,
        daemon_nonce: provider.daemonNonce,
        app_nonce: provider.proof.app_nonce,
        session_id: session.sessionId,
        client_name: session.clientName,
        reason: session.reason,
        pre_approved: session.preApproved,
        expires_at_epoch_seconds: nowEpochSeconds + (overrides.lifetimeSeconds ?? GRANT_LIFETIME_SECONDS),
    };
    return signGrant(payload, overrides.signingKey || loadSigningKey());
}

// A key and a proof that are not the app's, for the fake-provider test.
function forgedProof(daemonNonce, appKeyId) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const appNonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
    const signature = crypto.sign(null, proofBytes(daemonNonce, appNonce), privateKey);
    return { app_key_id: appKeyId, app_nonce: appNonce, signature: signature.toString("base64") };
}

module.exports = { issueGrant, verifyProof, forgedProof };
