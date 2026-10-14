/**
 * Resend reports delivery failures as `{ data: null, error }` instead of throwing: they must be
 * detected (EmailDeliveryError, logged), and registering must still work when the verification
 * email fails (the user can ask for it again).
 */
import { afterAll, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  return vi.fn();
});

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const { sendVerificationEmail, sendPasswordResetEmail, EmailDeliveryError } = await import("../src/lib/email.js");
const { registerUser } = await import("../src/modules/auth/auth.service.js");
const { prisma } = await import("../src/lib/prisma.js");

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Resend error results", () => {
  it("an { error } result throws EmailDeliveryError (502) and is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockResolvedValueOnce({ data: null, error: { name: "validation_error", message: "Invalid `to` field" } });
    const failure = sendVerificationEmail("x@example.com", "x", "tok");
    await expect(failure).rejects.toBeInstanceOf(EmailDeliveryError);
    await expect(failure).rejects.toMatchObject({ statusCode: 502, code: "EMAIL_DELIVERY_FAILED" });
    expect(logged).toHaveBeenCalledWith("[email] verification email failed:", expect.objectContaining({ name: "validation_error" }));

    send.mockRejectedValueOnce(new Error("network down"));
    await expect(sendPasswordResetEmail("x@example.com", "x", "tok")).rejects.toBeInstanceOf(EmailDeliveryError);

    send.mockResolvedValueOnce({ data: { id: "ok" }, error: null });
    await expect(sendVerificationEmail("x@example.com", "x", "tok")).resolves.toBeUndefined();
    logged.mockRestore();
  });

  it("registration succeeds even when the verification email fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockResolvedValue({ data: null, error: { name: "rate_limit_exceeded", message: "slow down" } });
    const tag = Math.random().toString(36).slice(2, 8);
    const result = await registerUser({
      email: `resend-${tag}@example.com`,
      username: `resend_${tag}`,
      password: "Hunter!2026abc",
      acceptedTerms: true,
    } as Parameters<typeof registerUser>[0]);
    expect(result.user.emailVerified).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("not sent"), expect.any(EmailDeliveryError));
    send.mockReset();
    logged.mockRestore();
  });
});
