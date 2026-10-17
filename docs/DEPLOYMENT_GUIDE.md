# 🚀 CloudTAK Infrastructure - Deployment Guide

## **Quick Start (Recommended)**

### **Prerequisites**
- AWS Account with configured credentials
- Base infrastructure stack (`TAK-<n>-BaseInfra`) deployed
- Public Route 53 hosted zone for your domain
- Node.js and npm installed
- Docker installed and running

### **One-Command Deployment**
```bash
# Install dependencies (from cdk directory)
cd cdk && npm install

# Deploy development environment
npm run deploy:dev

# Deploy production environment  
npm run deploy:prod
```

**That's it!** 🎉 The CDK deployment handles building, context configuration, and deployment.

---

## **📋 Environment Configurations**

| Environment | Stack Name | Domain | Features |
|-------------|------------|--------|----------|
| **dev-test** | `TAK-Dev-CloudTAK` | `map.dev.tak.nz` | Cost-optimized, Aurora Serverless v2 |
| **prod** | `TAK-Prod-CloudTAK` | `map.tak.nz` | Production-ready, Aurora Multi-AZ |

---

## **🔧 Advanced Configuration**

### **Custom Stack Deployment**
```bash
# Deploy with custom stack name
npm run deploy:dev -- --context stackName=Demo
npm run deploy:prod -- --context stackName=Enterprise
```

### **Infrastructure Preview**
```bash
# Preview changes before deployment
npm run synth:dev     # Development environment
npm run synth:prod    # Production environment

# Show what would change
npm run cdk:diff:dev  # Development diff
npm run cdk:diff:prod # Production diff
```

---

## **🔌 Installing CloudTAK plugins (WEB_PLUGINS)**

CloudTAK plugins are cloned into `app/plugins/` while the Docker image is built, using
the `WEB_PLUGINS` build arg. This repo sets it from CDK config.

- **Config:** `cloudtak.webPlugins` in `cdk/cdk.json`, per environment. Comma and/or
  whitespace separated `https://github.com/<owner>/<repo>.git` URLs. `dev-test` installs
  the rubbersheet plugin; `prod` is empty. Other URL forms (ssh, credentials, `#ref`,
  `file:`) are rejected at synth time.
- **Overrides:** `--context WebPlugins="<urls>"` (use `""` for none), then the
  `WEB_PLUGINS` environment variable, then `cdk.json`.
- **Manual deploy (Test stack):**
  ```bash
  npm run build && npm run cdk deploy -- \
    --context envType=dev-test \
    --context stackName=Demo \
    --context tak-project="TAK on AWS" \
    --context tak-component="CloudTAK" \
    --context tak-region=us-west-2 \
    --context useS3CloudTAKConfigFile=true \
    --require-approval never
  ```
  Add `--context WebPlugins="https://github.com/dfpc-coe/cloudtak-plugin-sample.git"` to
  install a different plugin set for that deploy.
- **CI:** the Demo build (`demo-build.yml`) uses the `dev-test` value and the production
  build uses the `prod` value from `cdk/cdk.json`. Pre-built images ignore
  `--context WebPlugins` at deploy time; the plugin set is fixed when the image is built.

**Gotchas**
- The clone happens after `COPY api/` and `COPY app/`, and it takes the plugin's
  **default branch** (`--depth 1`). A plugin-only change therefore does not change the
  image hash. In CI, re-run the build with `force_rebuild`. For a manual CDK deploy,
  change any file in `api/` or `app/` (or the plugin list) so the asset is rebuilt.
- The image build runs `npm run lint && npm run check` over `app/plugins/`, so a plugin
  must pass the app's lint and type checks or the build fails.
- Plugin dependencies must already be in `app/package.json` and its lockfile, because
  `npm ci` runs before plugins are cloned.
- After a deploy, users need Settings -> Refresh App to pick up the new plugin bundle.

---

## **🚀 First-Time Setup**

### **Prerequisites**
1. **AWS Account** with appropriate permissions
2. **Base Infrastructure** deployed (`TAK-<n>-BaseInfra`)
3. **Node.js** and npm installed  
4. **AWS CLI** configured with credentials
5. **Docker** installed and running

### **Initial Setup Steps**
```bash
# 1. Clone and install
git clone <repository-url>
cd CloudTAK/cdk
npm install

# 2. Set environment variables (if using AWS profiles)
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text --profile your-profile)
export CDK_DEFAULT_REGION=$(aws configure get region --profile your-profile)

# 3. Deploy CloudTAK infrastructure
npm run deploy:dev -- --context stackName=YourStackName
```

---

## **🔄 Environment Transformation**

### **Switching Between Environment Types**

You can transform deployed environments between different configuration profiles (dev-test ↔ prod) without recreating resources from scratch.

### **Initial Deployment with Custom Configuration**
```bash
# Deploy a demo environment with dev-test configuration
npm run deploy:dev -- --context stackName=Demo
```

### **Environment Upgrade (dev-test → prod)**
```bash
# Transform to production configuration
npm run deploy:prod -- --context stackName=Demo
```

### **Environment Downgrade (prod → dev-test)**
```bash
# Scale back to development configuration
npm run deploy:dev -- --context stackName=Demo
```

---

## **🛠️ Troubleshooting**

### **Common Issues**

#### **Missing Base Infrastructure**
```
Error: Cannot import value TAK-Demo-BaseInfra-VPC-ID
```
**Solution:** Ensure base infrastructure stack is deployed first.

#### **Docker Build Issues**
```
Error: Docker build failed
```
**Solution:** Ensure Docker is running and the Dockerfiles exist (`Dockerfile` at the repository root, and `tasks/*/Dockerfile`).

### **Debug Commands**
```bash
# Check what would be deployed
npm run synth:dev
npm run synth:prod

# See differences from current state
npm run cdk:diff:dev
npm run cdk:diff:prod

# View CloudFormation events
aws cloudformation describe-stack-events --stack-name TAK-Dev-CloudTAK
```

---

## **📊 Post-Deployment**

### **Verify Deployment**
```bash
# Check stack status
aws cloudformation describe-stacks --stack-name TAK-Dev-CloudTAK

# View outputs
aws cloudformation describe-stacks --stack-name TAK-Dev-CloudTAK \
  --query 'Stacks[0].Outputs'
```

### **Access Services**
- **CloudTAK Web Interface**: `https://map.{domain}`
- **CloudTAK API**: `https://map.{domain}/api`
- **ETL Tasks**: Managed via ECS console

### **Cleanup**
```bash
# Destroy development environment
npx cdk destroy --context envType=dev-test

# Destroy production environment (use with caution!)
npx cdk destroy --context envType=prod
```

---

## **🔗 Related Documentation**

- **[Main README](../README.md)** - Project overview and quick start
- **[Architecture Guide](ARCHITECTURE.md)** - Technical architecture details
- **[Configuration Guide](PARAMETERS.md)** - Complete configuration reference
- **[Docker Image Strategy](DOCKER_IMAGE_STRATEGY.md)** - Image building and deployment strategy
