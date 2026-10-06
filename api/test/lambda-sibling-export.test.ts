import test from 'node:test';
import assert from 'node:assert';
import Lambda from '../stateless/lib/aws/lambda.js';

// TAK-NZ: stack is `TAK-<env>-CloudTAK`; the CDK exports `<StackName>-<sibling>-<suffix>`
test('Lambda.siblingExport: TAK-NZ stack names resolve to the CDK exports', () => {
    const name = 'TAK-Dev-CloudTAK';
    assert.equal(Lambda.siblingExport(name, 'webhooks', 'api'), 'TAK-Dev-CloudTAK-webhooks-api');
    assert.equal(Lambda.siblingExport(name, 'webhooks', 'role'), 'TAK-Dev-CloudTAK-webhooks-role');
    assert.equal(Lambda.siblingExport(name, 'mail', 'layer-prefix'), 'TAK-Dev-CloudTAK-mail-layer-prefix');
});

test('Lambda.siblingExport: upstream stack names keep the upstream derivation', () => {
    const name = 'tak-cloudtak-prod';
    assert.equal(Lambda.siblingExport(name, 'webhooks', 'api'), 'tak-cloudtak-webhooks-prod-api');
    assert.equal(Lambda.siblingExport(name, 'webhooks', 'role'), 'tak-cloudtak-webhooks-prod-role');
    assert.equal(Lambda.siblingExport(name, 'mail', 'layer-prefix'), 'tak-cloudtak-mail-prod-layer-prefix');
});
