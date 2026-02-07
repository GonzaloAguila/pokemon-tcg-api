import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email("Correo electronico invalido"),
  username: z
    .string()
    .min(3, "El nombre de usuario debe tener al menos 3 caracteres")
    .max(20, "El nombre de usuario no puede exceder 20 caracteres")
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Solo se permiten letras, numeros y guion bajo",
    ),
  password: z
    .string()
    .min(8, "La contrasena debe tener al menos 8 caracteres"),
});

export const loginSchema = z.object({
  email: z.string().email("Correo electronico invalido"),
  password: z.string().min(1, "La contrasena es requerida"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "La contrasena actual es requerida"),
  newPassword: z
    .string()
    .min(8, "La nueva contrasena debe tener al menos 8 caracteres"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Correo electronico invalido"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token requerido"),
  newPassword: z
    .string()
    .min(8, "La nueva contrasena debe tener al menos 8 caracteres"),
});
