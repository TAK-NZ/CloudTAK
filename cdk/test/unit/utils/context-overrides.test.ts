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
});