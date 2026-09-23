const { register, resendVerification, verifyEmail } = require('./auth/registration');
const { login, refresh, logout, me } = require('./auth/sessions');
const { forgotPassword, resetPassword, changePassword } = require('./auth/passwords');

module.exports = {
  register,
  resendVerification,
  verifyEmail,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  me,
};
