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
