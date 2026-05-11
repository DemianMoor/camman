import { z } from "zod";

// Password strength: min 12 chars, must contain at least one letter and one digit.
// Symbols are allowed but not required.
const password = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .regex(/[A-Za-z]/, "Password must contain at least one letter")
  .regex(/[0-9]/, "Password must contain at least one number");

const email = z.string().trim().toLowerCase().email("Invalid email address");

export const signupSchema = z.object({
  email,
  password,
  displayName: z
    .string()
    .trim()
    .max(80, "Display name must be 80 characters or fewer")
    .optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
});

export const requestPasswordResetSchema = z.object({
  email,
});

export const resetPasswordSchema = z
  .object({
    newPassword: password,
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "Passwords must match",
    path: ["confirmNewPassword"],
  });

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
