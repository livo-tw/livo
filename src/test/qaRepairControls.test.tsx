import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import QaTargetEditor, { type QaTargetDraft } from '@/components/qa/QaTargetEditor';
import QaVersionInput from '@/components/qa/QaVersionInput';
import QaVerificationPanel from '@/components/qa/QaVerificationPanel';
import { QaSeverityBadge } from '@/components/qa/QaBadges';
import { priorityConfig } from '@/components/ui/badges';
import type { QaTarget } from '@/lib/qa/domain';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { number?: number }) => values?.number ? `${key} ${values.number}` : key }) }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ values: ['Stage', 'Prod'], ready: true, loadError: false }) }));
afterEach(cleanup);
const draft: QaTargetDraft = { environment: 'Stage', component: '', build: '', required: true };
const versions = { values: ['already-used-build'], status: 'ready' as const };

describe('compact repair targets', () => {
  it('starts with one environment and a blank fix build, hides advanced fields, and adds only explicit targets', () => {
    function Repair() {
      const [targets, setTargets] = useState([draft]);
      return <QaTargetEditor targets={targets} onChange={setTargets} versions={versions} />;
    }
    const view = render(<Repair />);
    expect(screen.getByLabelText(/qa.environment/)).toHaveValue('Stage');
    const build = screen.getByRole('combobox', { name: /qa.build/ });
    expect(build).toHaveValue('');
    expect(build).toBeRequired();
    expect(view.container.querySelectorAll('datalist option')).toHaveLength(1);
    expect(screen.queryByLabelText('qa.versionChoose')).toBeNull();
    const more = view.container.querySelector('details')!;
    expect(more).not.toHaveAttribute('open');
    expect(screen.getByLabelText(/qa.fixComponent/)).toHaveValue('');
    expect(screen.getByLabelText(/qa.fixComponent/)).not.toBeRequired();
    expect(screen.getByLabelText('qa.required')).toBeChecked();
    expect(screen.getByLabelText('qa.required')).toBeDisabled();
    fireEvent.change(build, { target: { value: 'new-repair-commit' } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.addEnvironment' }));
    expect(screen.getAllByLabelText(/qa.environment/)).toHaveLength(2);
    expect(screen.getAllByRole('combobox', { name: /qa.build/ })[0]).toHaveValue('new-repair-commit');
    expect(screen.getAllByRole('combobox', { name: /qa.build/ })[1]).toHaveValue('');
    expect(screen.getAllByLabelText(/qa.environment/)[1]).toHaveValue('');
    const boxes = screen.getAllByLabelText('qa.required');
    fireEvent.click(boxes[1]);
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).not.toBeChecked();
    expect(screen.getAllByRole('button', { name: 'qa.remove' })[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'qa.remove' })[1]);
    expect(screen.getAllByLabelText(/qa.environment/)).toHaveLength(1);
    expect(screen.getByLabelText(/qa.build/)).toHaveValue('new-repair-commit');
  });

  it('preserves a retired observed environment for review but only offers active new choices', () => {
    render(<QaTargetEditor targets={[{ ...draft, environment: 'Old stage' }]} onChange={vi.fn()} versions={versions} />);
    const environment = screen.getByLabelText(/qa.environment/);
    expect(environment).toHaveValue('Old stage');
    expect(within(environment).getByRole('option', { name: /Old stage/ })).toBeDisabled();
    expect(within(environment).getByRole('option', { name: 'Stage' })).toBeEnabled();
    expect(screen.getByLabelText(/qa.build/)).toHaveValue('');
  });

  it('retains manual version entry after failed suggestions and never renders a second selector', () => {
    const change = vi.fn();
    render(<QaVersionInput label="Build" value="typed-commit" onChange={change} required suggestions={{ values: [], status: 'failed' }} />);
    const input = screen.getByRole('combobox', { name: /^Build/ });
    expect(input).toHaveValue('typed-commit');
    expect(input).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('qa.versionLoadFailed');
    fireEvent.change(input, { target: { value: 'new-commit' } });
    expect(change).toHaveBeenCalledWith('new-commit');
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });
});

const target = (id: string, required = true, deployed = true): QaTarget => ({ id, environment: id, component: '', build: `build-${id}`, required,
  deployedAt: deployed ? '2026-10-03T00:00:00Z' : null, deployedBy: deployed ? 'developer' : null, deploymentEvidence: deployed ? 'Synthetic delivery' : '' });

describe('verification intent and evidence guard', () => {
  it('applies a dragged FAIL only to the first deployed required target and requires its note', () => {
    const command = vi.fn(async () => undefined);
    render(<QaVerificationPanel targets={[target('optional', false), target('waiting', true, false), target('first'), target('second')]}
      initialResult="fail" canDeploy canVerify busy={false} onCommand={command} />);
    const first = screen.getByRole('heading', { name: 'first / build-first' }).closest('article')!;
    expect(within(first).getByLabelText('qa.resultField')).toHaveValue('fail');
    expect(within(first).getByLabelText(/qa.note/)).toBeRequired();
    expect(screen.getAllByLabelText('qa.resultField').map(node => (node as HTMLSelectElement).value)).toEqual(['pass', 'fail', 'pass']);
    fireEvent.click(within(first).getByRole('button', { name: 'qa.verification' }));
    expect(command).not.toHaveBeenCalled();
    fireEvent.change(within(first).getByLabelText(/qa.note/), { target: { value: 'Still reproduces' } });
    fireEvent.click(within(first).getByRole('button', { name: 'qa.verification' }));
    expect(command).toHaveBeenCalledWith({ type: 'record_verification', targetId: 'first', build: 'build-first', result: 'fail', note: 'Still reproduces' });
    const waiting = screen.getByRole('heading', { name: 'waiting / build-waiting' }).closest('article')!;
    expect(within(waiting).queryByLabelText('qa.resultField')).toBeNull();
    fireEvent.change(within(waiting).getByLabelText(/qa.deploymentEvidence/), { target: { value: 'Deployed the exact build' } });
    fireEvent.click(within(waiting).getByRole('button', { name: 'qa.deployment' }));
    expect(command).toHaveBeenLastCalledWith({ type: 'record_deployment', targetId: 'waiting', build: 'build-waiting', evidence: 'Deployed the exact build' });
  });

  it('keeps ordinary PASS selection editable and hides forms without permissions', () => {
    const command = vi.fn(async () => undefined);
    const view = render(<QaVerificationPanel targets={[target('first')]} canDeploy={false} canVerify busy={false} onCommand={command} />);
    expect(screen.getByLabelText('qa.resultField')).toHaveValue('pass');
    expect(screen.getByLabelText('qa.note')).not.toBeRequired();
    fireEvent.change(screen.getByLabelText('qa.resultField'), { target: { value: 'blocked' } });
    expect(screen.getByLabelText(/qa.note/)).toBeRequired();
    view.rerender(<QaVerificationPanel targets={[target('first')]} canDeploy={false} canVerify={false} busy={false} onCommand={command} />);
    expect(screen.queryByRole('button', { name: 'qa.verification' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'qa.deployment' })).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });
});

describe('severity presentation', () => {
  it.each(['low', 'medium', 'high'] as const)('reuses task icon styling for %s while retaining severity semantics', severity => {
    const view = render(<QaSeverityBadge severity={severity} />);
    expect(screen.getByTitle('qa.severity')).toHaveTextContent(`qa.severity: qa.severityNames.${severity}`);
    const icon = view.container.querySelector('[aria-hidden="true"]')!;
    expect(icon).toHaveClass(priorityConfig[severity].className, priorityConfig[severity].bg);
    expect(view.container.textContent).not.toContain('priority.');
  });
});
