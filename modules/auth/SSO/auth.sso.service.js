/**
 * SSO Service - WorkOS Integration for Enterprise SSO
 * 
 * Supports: Okta, Azure AD/Entra ID, Google Workspace, OneLogin, etc.
 * 
 * Flow:
 * 1. User clicks "Sign in with SSO"
 * 2. Frontend calls POST /sso/login/org-domain or /sso/login/email
 * 3. Backend redirects to WorkOS authorization URL
 * 4. User authenticates with their IdP (Okta/Azure AD/Google)
 * 5. IdP redirects back to /sso/callback with authorization code
 * 6. Backend exchanges code for user profile
 * 7. Backend creates/updates user in DB and issues JWT
 */

const { WorkOS } = require('@workos-inc/node');
const User = require('../models/user.model');
const Employee = require('../../employee/models/employee.model');
const Role = require('../../role/role.model');
const Subscription = require('../../subscription/models/subscription.Models');
const Permission = require('../../permission/permission.model');
const SSOConnection = require('./models/sso-connection.model');
const SSOState = require('./models/sso-state.model');
const jwt = require('jsonwebtoken');
const AppError = require('../../../utils/appError');
const { generateRandomToken } = require('../../../utils/crypto');
const { assertPlanAllowsCompanyRoles } = require('../../../utils/companyRoleEntitlement');

// Initialize WorkOS client (optional - gracefully handle missing credentials)
let workos = null;
if (process.env.WORKOS_API_KEY || process.env.WORKOS_CLIENT_ID) {
  workos = new WorkOS(process.env.WORKOS_API_KEY || process.env.WORKOS_CLIENT_ID);
} else {
  console.warn('⚠️  WorkOS credentials not configured. SSO features will be disabled.');
}

const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID;
const WORKOS_REDIRECT_URI = process.env.WORKOS_REDIRECT_URI || `${process.env.BACKEND_URL}/api/v1/auth/sso/callback`;

// Map SSO connection types to readable names
const CONNECTION_TYPE_MAP = {
  'okta': 'Okta',
  'azure': 'Azure AD',
  'azuread': 'Azure AD',
  'google': 'Google Workspace',
  'onelogin': 'OneLogin',
  'saml': 'SAML SSO'
};

/**
 * Get SSO authorization URL for an organization
 * 
 * @param {string} orgId - Organization ID
 * @returns {Promise<{authorizationUrl: string, state: string}>}
 */
const getAuthorizationUrl = async (orgId) => {
  // Determine environment (default to development if not set)
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  
  // Lookup SSO connection for this organization and environment
  const ssoConnection = await SSOConnection.findOne({ 
    org_id: orgId, 
    environment: environment,
    active: true 
  });
  
  if (!ssoConnection) {
    throw new AppError(`SSO is not configured for this organization in ${environment} environment`, 400);
  }

  const state = generateRandomToken(16);
  
  console.log('🔍 DEBUG - Generated state:', state);
  
  // Store state temporarily for verification in callback
  const savedState = await SSOState.create({
    state,
    org_id: orgId,
    connectionId: ssoConnection.connectionId,
    email: '', // Will be updated in email flow
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
  });
  
  console.log('✅ DEBUG - State saved to MongoDB:', { 
    stateId: savedState._id, 
    state: savedState.state,
    org_id: savedState.org_id,
    expiresAt: savedState.expiresAt
  });

  // For AuthKit - return configuration for embedded sign-in
  // This allows sign-in to happen within the app UI
  const authKitUrl = `https://api.workos.com/sso/authorize?client_id=${WORKOS_CLIENT_ID}&redirect_uri=${encodeURIComponent(WORKOS_REDIRECT_URI)}&state=${state}&organization=${ssoConnection.connectionId}`;

  console.log('🔍 DEBUG - AuthKit Configuration:', { 
    clientId: WORKOS_CLIENT_ID, 
    redirectUri: WORKOS_REDIRECT_URI, 
    organization: ssoConnection.connectionId, 
    state 
  });

  console.log('🔍 DEBUG - AuthKit URL:', authKitUrl);

  return { 
    authorizationUrl: authKitUrl, 
    state,
    authKitConfig: {
      clientId: WORKOS_CLIENT_ID,
      redirectUri: WORKOS_REDIRECT_URI,
      organization: ssoConnection.connectionId
    }
  };
};

/** * Get WorkOS AuthKit configuration for embedded sign-in
 * This allows sign-in to happen within the app
 * 
 * @returns {object} AuthKit configuration
 */
const getAuthKitConfig = () => {
  return {
    clientId: WORKOS_CLIENT_ID,
    redirectUri: WORKOS_REDIRECT_URI,
    // AuthKit will handle the sign-in UI within the app
  };
};

/** * Get SSO authorization URL for an email domain
 * 
 * @param {string} email - User email address
 * @returns {Promise<{authorizationUrl: string, state: string}>}
 */
const getAuthorizationUrlByEmail = async (email) => {
  const emailDomain = email.split('@')[1];  
  
  // Determine environment (default to development if not set)
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  
  // Find organization by SSO domain configuration and environment
  const ssoConnection = await SSOConnection.findOne({ 
    domain: emailDomain, 
    environment: environment,
    active: true 
  });

  if (!ssoConnection) {
    throw new AppError(`SSO is not available for this email domain in ${environment} environment`, 400);
  }

  const state = generateRandomToken(16);
  
  await SSOState.create({
    state,
    org_id: ssoConnection.org_id,
    connectionId: ssoConnection.connectionId,
    email: email.toLowerCase(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000)
  });

  // For AuthKit - return configuration for embedded sign-in
  // This allows sign-in to happen within the app UI
  const authKitUrl = `https://api.workos.com/sso/authorize?client_id=${WORKOS_CLIENT_ID}&redirect_uri=${encodeURIComponent(WORKOS_REDIRECT_URI)}&state=${state}&organization=${ssoConnection.connectionId}`;

  console.log('🔍 DEBUG - AuthKit Email Configuration:', { 
    clientId: WORKOS_CLIENT_ID, 
    redirectUri: WORKOS_REDIRECT_URI, 
    organization: ssoConnection.connectionId, 
    state,
    email 
  });

  console.log('🔍 DEBUG - AuthKit URL:', authKitUrl);

  return { 
    authorizationUrl: authKitUrl, 
    state,
    authKitConfig: {
      clientId: WORKOS_CLIENT_ID,
      redirectUri: WORKOS_REDIRECT_URI,
      organization: ssoConnection.connectionId
    }
  };
};

/**
 * Exchange authorization code for user profile and create/update user
 * 
 * @param {string} code - Authorization code from callback
 * @returns {Promise<{token: string, user: object, isNewUser: boolean}>}
 */
const handleCallback = async (code, state) => {
  // Verify state
  const ssoState = await SSOState.findOne({ state });
  
  if (!ssoState || ssoState.expiresAt < new Date()) {
    throw new AppError('Invalid or expired SSO session', 401);
  }

  // Exchange code for profile
  const { profile } = await workos.sso.getProfileAndToken({
    code,
    clientId: WORKOS_CLIENT_ID,
  });

  // Delete used state
  await SSOState.findByIdAndDelete(ssoState._id);

  // Extract profile attributes
  const {
    id: profileId,
    email,
    firstName,
    lastName,
    connectionId,
    connectionType,
    raw_attributes
  } = profile;

  // Find existing user by email
  let user = await User.findOne({ email: email.toLowerCase(), is_deleted: false });
  let isNewUser = false;

  // JIT Provisioning - Create user if doesn't exist
  if (!user) {
    // Determine role from SSO or default
    const defaultRoleSlug = process.env.SSO_DEFAULT_ROLE || 'employee';
    const role = await Role.findOne({ slug: defaultRoleSlug });
    
    if (!role) {
      throw new AppError('Default role not found. Contact administrator.', 500);
    }

    if (role.level === 'company') {
      await assertPlanAllowsCompanyRoles(ssoState.org_id);
      // JIT has no company context; it cannot create a usable company admin.
      throw new AppError('A company is required for a company-level role', 400);
    }

    user = new User({
      email: email.toLowerCase(),
      name: `${firstName || ''} ${lastName || ''}`.trim(),
      firstName,
      lastName,
      org_id: ssoState.org_id,
      roleId: role._id,
      status: 'ACTIVE',
      isEmailVerified: true,
      ssoProfileId: profileId,
      ssoConnectionId: connectionId,
      ssoProvider: CONNECTION_TYPE_MAP[connectionType] || connectionType,
      // No password for SSO users
    });

    await user.save();
    isNewUser = true;
  } else {
    // Update existing user's SSO info
    user.ssoProfileId = profileId;
    user.ssoConnectionId = connectionId;
    user.ssoProvider = CONNECTION_TYPE_MAP[connectionType] || connectionType;
    await user.save();
  }

  // Generate JWT
  const token = generateJWT(user);

  return {
    token,
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.roleId,
      org_id: user.org_id,
      company_id: user.company_id,
      unit_id: user.unit_id,
      ssoProvider: user.ssoProvider
    },
    isNewUser
  };
};

/**
 * Generate JWT for SSO authenticated user
 */
const generateJWT = (user) => {
  const payload = {
    userId: user._id,
    org_id: user.org_id,
    company_id: user.company_id,
    unit_id: user.unit_id,
    role: user.roleId?.slug || 'employee',
    sso: true
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
};

/**
 * Configure SSO connection for an organization
 * 
 * Called by org admin to enable SSO for their org
 */
const configureSSOConnection = async (orgId, connectionId, domain) => {
  const existing = await SSOConnection.findOne({ org_id: orgId });
  
  if (existing) {
    existing.connectionId = connectionId;
    existing.domain = domain;
    existing.active = true;
    existing.updatedAt = new Date();
    await existing.save();
    return existing;
  }

  const connection = new SSOConnection({
    org_id: orgId,
    connectionId,
    domain,
    active: true
  });

  await connection.save();
  return connection;
};

/**
 * Disable SSO for an organization
 */
const disableSSOConnection = async (orgId) => {
  await SSOConnection.findOneAndUpdate(
    { org_id: orgId },
    { active: false },
    { new: true }
  );
};

module.exports = {
  getAuthorizationUrl,
  getAuthorizationUrlByEmail,
  handleCallback,
  configureSSOConnection,
  disableSSOConnection
};
