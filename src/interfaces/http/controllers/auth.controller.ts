import type { RequestHandler } from 'express';
import type { AuthService } from '../../../application/use-cases/auth.service.js';
import type { PasswordResetService } from '../../../application/use-cases/password-reset.service.js';
import { actorOf, ok } from '../http-context.js';
import { passwordResetBody, registerBody } from '../validators/auth.schemas.js';
import { parse } from '../validators/validate.js';

export function authController(auth: AuthService, passwordReset: PasswordResetService) {
  const register: RequestHandler = async (req, res) => {
    const body = parse(registerBody, req.body);
    ok(res, { profile: await auth.register(body) }, 201);
  };

  const me: RequestHandler = async (_req, res) => {
    ok(res, await auth.me(actorOf(res)));
  };

  /**
   * Always 202 with the same body, answered before any lookup or email work, so
   * neither the response nor its timing reveals whether the address has an account.
   */
  const requestPasswordReset: RequestHandler = async (req, res) => {
    const { email } = parse(passwordResetBody, req.body);
    ok(res, { requested: true }, 202);
    void passwordReset.request(email);
  };

  return { register, me, requestPasswordReset };
}
