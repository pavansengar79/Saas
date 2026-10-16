const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const User = require("../modules/auth/models/user.model");

passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_REDIRECT_URI
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const rawEmail = profile?.emails?.[0]?.value;
      if (!rawEmail || profile?._json?.email_verified === false) {
        return done(null, false, { message: "A verified Google email is required" });
      }

      const email = rawEmail.trim().toLowerCase();
      const existingUser = await User.findOne({ email, is_deleted: false });

      if (existingUser) {
        if (existingUser.googleId && existingUser.googleId !== profile.id) {
          return done(null, false, { message: "This email is linked to a different Google account" });
        }

        if (!existingUser.googleId) {
          existingUser.googleId = profile.id;
          await existingUser.save({ validateBeforeSave: false });
        }

        return done(null, { userId: existingUser._id, googleId: profile.id });
      }

      return done(null, {
        email,
        name: profile.displayName || "",
        googleId:  profile.id,
        isNewUser: true
      });

    } catch (error) {
      done(error, null);
    }
  }
));

module.exports = passport;