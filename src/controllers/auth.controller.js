/**
 * Re-export barrel (BE-11-T04). Registration, sessions and passwords each live in
 * ./auth/*; the token primitives in auth/tokens.js (BE-11-T05 moves the generic
 * ones to utils/authPrimitives.js). auth.routes.js imports this path.
 */
const registration = require('./auth/registration');
const sessions = require('./auth/sessions');
const passwords = require('./auth/passwords');

module.exports = {
  changePassword: passwords.changePassword,
  forgotPassword: passwords.forgotPassword,
  login: sessions.login,
  logout: sessions.logout,
  me: sessions.me,
  refresh: sessions.refresh,
  register: registration.register,
  resendVerification: registration.resendVerification,
  resetPassword: passwords.resetPassword,
  verifyEmail: registration.verifyEmail,
};
