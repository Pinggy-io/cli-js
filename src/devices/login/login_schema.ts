import { z } from "zod";

/**
 * The dashboard's answers to `pinggy devices login`, validated before any field is used.
 *
 * Mirrors the DTOs of DeviceAgentLoginController in the pinggy_backend repo. See
 * docs/pinggy-devices/slices/11-email-sign-in.md and 12-email-link-approval.md there.
 */

/**
 * The answer to `start`. `device_code` is this CLI's handle on the sign-in, and only it holds it.
 * `match_code`, such as `KQD-WMT`, is printed here and shown on the email's approve page, so the user can tell
 * this request from someone else's. Not a secret. Optional, so a dashboard without the emailed link still works.
 */
export const LoginStartedSchema = z.object({
    device_code: z.string().min(1),
    match_code: z.string().min(1).optional(),
    expires_in_seconds: z.number().int().positive(),
    poll_interval_seconds: z.number().int().positive(),
});
export type LoginStarted = z.infer<typeof LoginStartedSchema>;

export const LoginStatus = {
    Pending: "pending",
    MfaRequired: "mfa_required",
    Approved: "approved",
} as const;

/**
 * The answer to `verify-code`, `verify-mfa` and `poll`. Null fields are left off by the dashboard.
 *
 * `approved` carries the device's credential and is answered once. `open_url` signs 1 browser in, once;
 * it comes only after a code typed here. `device_url` is the plain page, after the emailed link approved it:
 * that browser is the one signed in. `pending` from `verify-code` or `verify-mfa` means the emailed link won
 * the race, and the poll collects its device.
 */
export const LoginAnswerSchema = z.object({
    status: z.enum([LoginStatus.Pending, LoginStatus.MfaRequired, LoginStatus.Approved]),
    token: z.string().min(1).optional(),
    device_agent_id: z.string().min(1).optional(),
    device_name: z.string().optional(),
    open_url: z.string().optional(),
    device_url: z.string().optional(),
});
export type LoginAnswer = z.infer<typeof LoginAnswerSchema>;

/** Every refusal: `{ "error_type": "...", "errors": ["message"] }`. */
export const LoginErrorSchema = z.object({
    error_type: z.string(),
    errors: z.array(z.string()).default([]),
});

/** The error types this CLI acts on. Any other refusal stops the sign-in with its message. */
export const LoginErrorType = {
    /** A wrong code or authenticator code, with attempts left. Asked again. */
    InvalidCode: "device_login_invalid_code",
    /** Expired, ended after too many wrong codes, or already used. */
    Expired: "device_login_expired",
    RateLimited: "device_login_rate_limited",
    InvalidClient: "device_login_invalid_client",
} as const;
