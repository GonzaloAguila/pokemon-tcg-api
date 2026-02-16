import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

export function validatePasswordStrength(
  password: string,
): PasswordValidation {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push("La contrasena debe tener al menos 8 caracteres");
  }
  if (!/[A-Z]/.test(password)) {
    errors.push("Debe contener al menos una letra mayuscula");
  }
  if (!/[a-z]/.test(password)) {
    errors.push("Debe contener al menos una letra minuscula");
  }
  if (!/[0-9]/.test(password)) {
    errors.push("Debe contener al menos un numero");
  }

  return { valid: errors.length === 0, errors };
}
