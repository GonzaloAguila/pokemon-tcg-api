import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@nostalgic-tcg.online";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

let resend: Resend | null = null;

function getResend(): Resend | null {
  if (!RESEND_API_KEY) {
    return null;
  }
  if (!resend) {
    resend = new Resend(RESEND_API_KEY);
  }
  return resend;
}

export async function sendPasswordResetEmail(
  to: string,
  username: string,
  resetToken: string,
): Promise<void> {
  const client = getResend();
  if (!client) {
    console.warn(
      "[email] RESEND_API_KEY not configured — skipping password reset email",
    );
    console.log(
      `[email] Reset link: ${FRONTEND_URL}/reset-password?token=${resetToken}`,
    );
    return;
  }

  const resetUrl = `${FRONTEND_URL}/reset-password?token=${resetToken}`;

  await client.emails.send({
    from: FROM_EMAIL,
    to,
    subject: "Restablece tu contrasena - Nostalgic TCG",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #faf5e4; border-radius: 12px;">
        <h1 style="color: #451a03; text-align: center; margin-bottom: 8px;">Nostalgic TCG</h1>
        <p style="color: #92400e; text-align: center; margin-bottom: 24px;">Restablecimiento de contrasena</p>

        <p style="color: #451a03;">Hola <strong>${username}</strong>,</p>
        <p style="color: #78350f;">Has solicitado restablecer tu contrasena. Haz clic en el siguiente boton:</p>

        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}"
             style="background: linear-gradient(180deg, #ef4444, #b91c1c); color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            Restablecer contrasena
          </a>
        </div>

        <p style="color: #92400e; font-size: 14px;">Si no solicitaste esto, puedes ignorar este correo. El enlace expira en 1 hora.</p>

        <hr style="border: none; border-top: 1px solid #d6d3d1; margin: 24px 0;" />
        <p style="color: #a8a29e; font-size: 12px; text-align: center;">Nostalgic TCG - Pokemon Trading Card Game</p>
      </div>
    `,
  });
}

export interface BugReportAttachment {
  data: string; // base64-encoded image data (without data:... prefix)
  filename: string;
  contentType?: string;
}

export async function sendBugReportEmail(
  username: string,
  userId: string,
  title: string,
  description: string,
  attachments?: BugReportAttachment[],
): Promise<void> {
  const client = getResend();
  const adminEmail = process.env.ADMIN_EMAIL || FROM_EMAIL;

  if (!client) {
    console.warn("[email] RESEND_API_KEY not configured — skipping bug report email");
    console.log(`[email] Bug report from ${username}: ${title}`);
    return;
  }

  const resendAttachments = attachments?.map((att) => ({
    content: Buffer.from(att.data, "base64"),
    filename: att.filename,
    content_type: att.contentType,
  }));

  const descriptionHtml = description.replace(/\n/g, "<br />");

  await client.emails.send({
    from: FROM_EMAIL,
    to: adminEmail,
    subject: `[Bug Report] ${title}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #faf5e4; border-radius: 12px;">
        <h1 style="color: #451a03; text-align: center; margin-bottom: 8px;">Nostalgic TCG</h1>
        <p style="color: #92400e; text-align: center; margin-bottom: 24px;">Bug Report</p>

        <table style="width: 100%; margin-bottom: 16px; font-size: 14px;">
          <tr><td style="color: #92400e; padding: 4px 8px; font-weight: bold;">Usuario:</td><td style="color: #451a03;">${username}</td></tr>
          <tr><td style="color: #92400e; padding: 4px 8px; font-weight: bold;">User ID:</td><td style="color: #78350f; font-size: 12px;">${userId}</td></tr>
          <tr><td style="color: #92400e; padding: 4px 8px; font-weight: bold;">Fecha:</td><td style="color: #451a03;">${new Date().toLocaleString("es-ES", { timeZone: "America/Argentina/Buenos_Aires" })}</td></tr>
        </table>

        <div style="background: #fff; border: 1px solid #d6d3d1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
          <h2 style="color: #451a03; margin: 0 0 8px 0; font-size: 18px;">${title}</h2>
          <p style="color: #78350f; line-height: 1.6; margin: 0;">${descriptionHtml}</p>
        </div>

        ${attachments && attachments.length > 0 ? `<p style="color: #92400e; font-size: 13px;">${attachments.length} imagen(es) adjunta(s)</p>` : ""}

        <hr style="border: none; border-top: 1px solid #d6d3d1; margin: 24px 0;" />
        <p style="color: #a8a29e; font-size: 12px; text-align: center;">Nostalgic TCG - Bug Report System</p>
      </div>
    `,
    ...(resendAttachments && resendAttachments.length > 0
      ? { attachments: resendAttachments }
      : {}),
  });
}

export async function sendVerificationEmail(
  to: string,
  username: string,
  verificationToken: string,
): Promise<void> {
  const client = getResend();
  if (!client) {
    console.warn(
      "[email] RESEND_API_KEY not configured — skipping verification email",
    );
    console.log(
      `[email] Verification link: ${FRONTEND_URL}/verify-email?token=${verificationToken}`,
    );
    return;
  }

  const verifyUrl = `${FRONTEND_URL}/verify-email?token=${verificationToken}`;

  await client.emails.send({
    from: FROM_EMAIL,
    to,
    subject: "Verifica tu correo electronico - Nostalgic TCG",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #faf5e4; border-radius: 12px;">
        <h1 style="color: #451a03; text-align: center; margin-bottom: 8px;">Nostalgic TCG</h1>
        <p style="color: #92400e; text-align: center; margin-bottom: 24px;">Verificacion de correo electronico</p>

        <p style="color: #451a03;">Hola <strong>${username}</strong>,</p>
        <p style="color: #78350f;">Gracias por registrarte. Para activar tu cuenta, verifica tu correo electronico haciendo clic en el siguiente boton:</p>

        <div style="text-align: center; margin: 32px 0;">
          <a href="${verifyUrl}"
             style="background: linear-gradient(180deg, #22c55e, #16a34a); color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            Verificar Correo
          </a>
        </div>

        <p style="color: #92400e; font-size: 14px;">Si no creaste esta cuenta, puedes ignorar este correo. El enlace expira en 24 horas.</p>

        <hr style="border: none; border-top: 1px solid #d6d3d1; margin: 24px 0;" />
        <p style="color: #a8a29e; font-size: 12px; text-align: center;">Nostalgic TCG - Pokemon Trading Card Game</p>
      </div>
    `,
  });
}
