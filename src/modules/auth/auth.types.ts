export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
  starterColor?: "fire" | "water" | "grass" | "electric" | "psychic" | "fighting";
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
    provider: string;
  };
  accessToken: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}
