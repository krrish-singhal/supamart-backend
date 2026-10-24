// Strips fields that must never leave the server: password hash, reset-token internals.
// Every route that returns a user doc to the client must pass it through this first.
function publicUser(user) {
  if (!user) return user;
  const { passwordHash, resetPasswordTokenHash, resetPasswordExpires, resetPasswordOtp, deleteAccountOtp, deleteAccountOtpExpires, ...rest } = user;
  return rest;
}

module.exports = { publicUser };
