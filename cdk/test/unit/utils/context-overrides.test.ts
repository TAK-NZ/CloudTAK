import { App } from 'aws-cdk-lib';
import { applyContextOverrides } from '../../../lib/utils/context-overrides';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

describe('Context Overrides', () => {
  it('applies context overrides from app context', () => {
    const app = new App({
      context: {
        taskCpu: 1024,
        taskMemory: 2048,
        stackName: 'OverriddenStack'
      }
    });

    const result = applyContextOverrides(app, MOCK_CONFIGS.DEV_TEST);
    
    expect(result.ecs.taskCpu).toBe(1024);
    expect(result.ecs.taskMemory).toBe(2048);
    expect(result.stackName).toBe('OverriddenStack');
  });

  it('preserves base config when no overrides provided', () => {
    const app = new App();

    const result = applyContextOverrides(app, MOCK_CONFIGS.DEV_TEST);
    
    expect(result.ecs.taskCpu).toBe(MOCK_CONFIGS.DEV_TEST.ecs.taskCpu);
    expect(result.ecs.taskMemory).toBe(MOCK_CONFIGS.DEV_TEST.ecs.taskMemory);
    expect(result.stackName).toBe(MOCK_CONFIGS.DEV_TEST.stackName);
  });

  // Boolean context overrides are armed only by the exact string 'true'
  // (applyContextOverrides compares `=== 'true'`). This guards against a
  // refactor to `Boolean(raw)` or a loose truthy check, which would let a
  // near-miss like 'TRUE'/'1'/'yes' silently flip a flag.
  describe('strict-boolean override parsing', () => {
    // Start from a base where the flag is OFF so an override flipping it ON is
    // observable.
    const baseOff = {
      ...MOCK_CONFIGS.DEV_TEST,
      ecs: { ...MOCK_CONFIGS.DEV_TEST.ecs, enableEcsExec: false },
    };

    it("arms the flag for the exact string 'true'", () => {
      const app = new App({ context: { enableEcsExec: 'true' } });
      const result = applyContextOverrides(app, baseOff);
      expect(result.ecs.enableEcsExec).toBe(true);
    });

    it.each(['TRUE', '1', 'yes', ' true '])(
      "does not arm the flag for near-miss %p",
      (raw) => {
        const app = new App({ context: { enableEcsExec: raw } });
        const result = applyContextOverrides(app, baseOff);
        expect(result.ecs.enableEcsExec).toBe(false);
      }
    );
  });

  describe('break-glass overrides', () => {
    it('leaves the base block alone when nothing is overridden', () => {
      const base = { ...MOCK_CONFIGS.DEV_TEST, cloudtak: { ...MOCK_CONFIGS.DEV_TEST.cloudtak, breakGlass: { sealed: true, alertEmails: ['a@example.test'] } } };
      const result = applyContextOverrides(new App(), base);
      expect(result.cloudtak.breakGlass).toMatchObject({ sealed: true, alertEmails: ['a@example.test'] });
    });

    it('overrides each setting from -c, with comma-separated lists', () => {
      const app = new App({
        context: {
          breakGlassSealed: 'true',
          breakGlassAlertEmails: 'a@example.test, b@example.test',
          breakGlassRoleTrustedPrincipals: 'arn:aws:iam::123456789012:role/Ops',
          breakGlassRoleRequireMfa: 'false'
        }
      });
      const result = applyContextOverrides(app, MOCK_CONFIGS.DEV_TEST);
      expect(result.cloudtak.breakGlass).toEqual({
        sealed: true,
        alertEmails: ['a@example.test', 'b@example.test'],
        roleTrustedPrincipals: ['arn:aws:iam::123456789012:role/Ops'],
        roleRequireMfa: false
      });
    });

    it('an empty override clears a list from the base config', () => {
      const base = { ...MOCK_CONFIGS.DEV_TEST, cloudtak: { ...MOCK_CONFIGS.DEV_TEST.cloudtak, breakGlass: { alertEmails: ['a@example.test'] } } };
      const result = applyContextOverrides(new App({ context: { breakGlassAlertEmails: '' } }), base);
      expect(result.cloudtak.breakGlass?.alertEmails).toEqual([]);
    });
  });
});
