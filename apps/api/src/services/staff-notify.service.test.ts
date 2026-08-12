import { describe, expect, it } from 'vitest';
import type { ChatChannel, MessagingAdapter, OutboundMessage } from '@property-manager/adapters';
import { notifyStaffTargets, resolveStaffNotifyTargets, type NotifiableStaff } from './staff-notify.service.js';

describe('resolveStaffNotifyTargets', () => {
  const broker: NotifiableStaff = { id: 'u_broker', email: 'broker@test.ca', notificationChannel: null, notificationAddress: null };
  const assignee: NotifiableStaff = { id: 'u_assignee', email: 'assignee@test.ca', notificationChannel: null, notificationAddress: null };
  const pmA: NotifiableStaff = { id: 'u_pm_a', email: 'pma@test.ca', notificationChannel: null, notificationAddress: null };
  const pmB: NotifiableStaff = { id: 'u_pm_b', email: 'pmb@test.ca', notificationChannel: null, notificationAddress: null };
  const staff = [broker, assignee, pmA, pmB];

  it('prefers the broker over everyone else', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: 'u_broker',
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([broker]);
  });

  it('falls back to the assignee when there is no broker', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: null,
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([assignee]);
  });

  it('falls back to every property manager when there is neither broker nor assignee', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: null,
      assignedUserId: null,
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([pmA, pmB]);
  });

  it('skips an id that does not resolve to a known staff member', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: 'u_deleted',
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a'],
    })).toEqual([assignee]);
  });

  it('returns an empty list when nothing resolves', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: null,
      assignedUserId: null,
      staff: [],
      propertyManagerIds: [],
    })).toEqual([]);
  });
});

function fakeMessaging(options: { shouldFail?: boolean } = {}) {
  const sent: OutboundMessage[] = [];
  const adapter: MessagingAdapter = {
    channel: 'telegram',
    async send(message: OutboundMessage) {
      if (options.shouldFail) throw new Error('simulated send failure');
      sent.push(message);
      return { messageId: `msg_${sent.length}` };
    },
    async parseWebhook() {
      throw new Error('not used in this test');
    },
  };
  return {
    sent,
    messaging: { telegram: adapter, web: adapter, email: adapter } as unknown as Record<ChatChannel, MessagingAdapter>,
  };
}

describe('notifyStaffTargets', () => {
  it('sends by email and by the preferred chat channel independently', async () => {
    const { sent, messaging } = fakeMessaging();
    const target: NotifiableStaff = {
      id: 'u_1', email: 'pm@test.ca', notificationChannel: 'telegram', notificationAddress: '900200',
    };

    await notifyStaffTargets({ targets: [target], subject: 'Subject', body: 'Body', messaging });

    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.channel)).toEqual(expect.arrayContaining(['email', 'telegram']));
  });

  it('skips the chat channel when it is web or email', async () => {
    const { sent, messaging } = fakeMessaging();
    const target: NotifiableStaff = {
      id: 'u_1', email: 'pm@test.ca', notificationChannel: 'web', notificationAddress: 'conv_1',
    };

    await notifyStaffTargets({ targets: [target], subject: 'Subject', body: 'Body', messaging });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe('email');
  });

  it('never throws, even if every channel fails', async () => {
    const { messaging } = fakeMessaging({ shouldFail: true });
    const target: NotifiableStaff = {
      id: 'u_1', email: 'pm@test.ca', notificationChannel: 'telegram', notificationAddress: '900200',
    };

    await expect(notifyStaffTargets({ targets: [target], subject: 'Subject', body: 'Body', messaging })).resolves.toBeUndefined();
  });
});
