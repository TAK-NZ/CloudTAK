const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

exports.handler = async (event, context) => {
  console.log('CloudTAK OIDC Setup - Event:', JSON.stringify(event, null, 2));
  
  try {
    // Handle CloudFormation DELETE
    if (event.RequestType === 'Delete') {
      console.log('DELETE request - preserving Authentik resources');
      return {
        PhysicalResourceId: event.PhysicalResourceId || 'cloudtak-oidc-setup',
        Data: {},
      };
    }
    
    // Get admin token from Secrets Manager
    const secretsManager = new SecretsManagerClient();
    const secretName = process.env.AUTHENTIK_ADMIN_SECRET_ARN;
    
    const getCommand = new GetSecretValueCommand({ SecretId: secretName });
    const secretData = await secretsManager.send(getCommand);
    
    let adminToken;
    try {
      const secret = JSON.parse(secretData.SecretString);
      adminToken = secret.token;
    } catch {
      adminToken = secretData.SecretString;
    }
    
    // Configure Authentik API client
    const authentikUrl = process.env.AUTHENTIK_URL;
    const api = axios.create({
      baseURL: authentikUrl,
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    // Get authorization flow
    const authorizationFlow = await getFlowByName(api, 'default-provider-authorization-implicit-consent');
    const invalidationFlow = await getFlowByName(api, 'default-provider-invalidation-flow');
    
    // Create OAuth2 provider
    const providerName = 'TAK-CloudTAK';
    const redirectUris = JSON.parse(process.env.REDIRECT_URIS).map(uri => ({
      url: uri,
      matching_mode: 'strict'
    }));
    
    // Get required scope mappings
    const scopeMappings = [];
    for (const scope of ['email', 'openid', 'profile']) {
      const mapping = await getOrCreateScopeMapping(api, scope);
      scopeMappings.push(mapping.pk);
    }
    
    const provider = await createOrUpdateProvider(api, {
      name: providerName,
      authorization_flow: authorizationFlow.pk,
      invalidation_flow: invalidationFlow.pk,
      redirect_uris: redirectUris,
      client_type: 'confidential',
      include_claims_in_id_token: true,
      access_code_validity: 'minutes=1',
      access_token_validity: 'minutes=5',
      refresh_token_validity: 'days=30',
      property_mappings: scopeMappings,
    });
    
    // Create application
    const applicationName = process.env.APPLICATION_NAME;
    const applicationSlug = process.env.APPLICATION_SLUG;
    const launchUrl = process.env.LAUNCH_URL;
    const groupName = process.env.GROUP_NAME;
    
    const application = await createOrUpdateApplication(api, {
      name: applicationName,
      slug: applicationSlug,
      provider: provider.pk,
      meta_launch_url: launchUrl,
      meta_description: 'Web-based geospatial collaboration platform.',
      open_in_new_tab: false,
    });
    
    // Upload icon
    await uploadApplicationIcon(api, application.slug);
    
    // Assign to group
    if (groupName) {
      await assignGroupToApplication(api, application.slug, groupName);
    }
    
    // Get OIDC configuration
    const oidcConfig = await getOidcConfiguration(authentikUrl, applicationSlug);
    
    console.log('CloudTAK OIDC setup completed successfully');
    
    return {
      PhysicalResourceId: provider.pk.toString(),
      Data: {
        clientId: provider.client_id,
        clientSecret: provider.client_secret,
        issuer: oidcConfig.issuer,
        authorizeUrl: oidcConfig.authorizeUrl,
        tokenUrl: oidcConfig.tokenUrl,
        userInfoUrl: oidcConfig.userInfoUrl,
      }
    };
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

async function getFlowByName(api, name) {
  try {
    const response = await api.get('/api/v3/flows/instances/', { params: { name } });
    if (response.data.results && response.data.results.length > 0) {
      return response.data.results[0];
    }
  } catch (error) {
    console.warn(`Flow lookup by name failed: ${error.message}`);
  }
  
  const allFlows = await api.get('/api/v3/flows/instances/');
  const flow = allFlows.data.results.find(f => f.slug === name);
  if (flow) return flow;
  
  throw new Error(`Flow not found: ${name}`);
}

async function createOrUpdateProvider(api, providerData) {
  const existing = await api.get('/api/v3/providers/oauth2/', {
    params: { name: providerData.name }
  });
  
  let provider;
  if (existing.data.results && existing.data.results.length > 0) {
    const existingProvider = existing.data.results[0];
    const response = await api.patch(`/api/v3/providers/oauth2/${existingProvider.pk}/`, providerData);
    provider = response.data;
  } else {
    const response = await api.post('/api/v3/providers/oauth2/', providerData);
    provider = response.data;
  }
  
  // Ensure we have client_id and client_secret
  if (!provider.client_id || !provider.client_secret) {
    const detailsResponse = await api.get(`/api/v3/providers/oauth2/${provider.pk}/`);
    provider = detailsResponse.data;
  }
  
  return provider;
}

async function createOrUpdateApplication(api, applicationData) {
  try {
    const response = await api.get(`/api/v3/core/applications/${applicationData.slug}/`);
    const updateResponse = await api.patch(`/api/v3/core/applications/${applicationData.slug}/`, applicationData);
    return updateResponse.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      const response = await api.post('/api/v3/core/applications/', applicationData);
      return response.data;
    }
    throw error;
  }
}

async function assignGroupToApplication(api, appSlug, groupName) {
  try {
    await api.patch(`/api/v3/core/applications/${appSlug}/`, { group: groupName });
  } catch (error) {
    console.warn('Failed to assign group:', error.message);
  }
}

async function uploadApplicationIcon(api, appSlug) {
  try {
    const appResponse = await api.get(`/api/v3/core/applications/${appSlug}/`);
    if (appResponse.data.meta_icon) {
      console.log('Application already has icon');
      return;
    }
    
    const iconPath = path.join(__dirname, 'CloudTAKLogo.png');
    if (!fs.existsSync(iconPath)) {
      console.warn('Icon file not found');
      return;
    }
    
    const form = new FormData();
    form.append('file', fs.createReadStream(iconPath));
    
    await api.post(`/api/v3/core/applications/${appSlug}/set_icon/`, form, {
      headers: form.getHeaders(),
    });
    
    console.log('Icon uploaded successfully');
  } catch (error) {
    console.warn('Failed to upload icon:', error.message);
  }
}

async function getOrCreateScopeMapping(api, scopeName) {
  const existing = await api.get('/api/v3/propertymappings/provider/scope/', {
    params: { scope_name: scopeName }
  });
  
  if (existing.data.results && existing.data.results.length > 0) {
    return existing.data.results[0];
  }
  
  const response = await api.post('/api/v3/propertymappings/provider/scope/', {
    name: `authentik default OAuth Mapping: OpenID '${scopeName}'`,
    scope_name: scopeName,
    expression: 'return {}',
    description: `Standard OpenID Connect scope: ${scopeName}`
  });
  
  return response.data;
}

async function getOidcConfiguration(authentikUrl, applicationSlug) {
  try {
    const appConfigUrl = `${authentikUrl}/application/o/${applicationSlug}/.well-known/openid-configuration`;
    // Create a new axios instance without baseURL for this specific call
    const response = await axios.create().get(appConfigUrl);
    
    return {
      issuer: response.data.issuer,
      authorizeUrl: response.data.authorization_endpoint,
      tokenUrl: response.data.token_endpoint,
      userInfoUrl: response.data.userinfo_endpoint,
    };
  } catch (error) {
    console.warn('Failed to fetch OIDC config, using defaults:', error.message);
    return {
      issuer: `${authentikUrl}/application/o/${applicationSlug}/`,
      authorizeUrl: `${authentikUrl}/application/o/authorize/`,
      tokenUrl: `${authentikUrl}/application/o/token/`,
      userInfoUrl: `${authentikUrl}/application/o/userinfo/`,
    };
  }
}
