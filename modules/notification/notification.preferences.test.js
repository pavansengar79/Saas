const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');

const User = require('../auth/models/user.model');
const Notification = require('./notification.model');
const email = require('../../utils/email/email');

const originalSendEmail = email.sendEmail;
let emailCalls = 0;
email.sendEmail = async () => { emailCalls++; };
const service = require('./notification.service');
email.sendEmail = originalSendEmail;

const userId = new mongoose.Types.ObjectId();
const orgId = new mongoose.Types.ObjectId();
const user = { userId: userId.toString(), orgId: orgId.toString() };

test('notification email preference loads, validates, and persists', async () => {
  const originalFindById = User.findById;
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  let update;

  try {
    User.findById = () => ({ select: () => ({ lean: async () => ({ notificationEmailEnabled: false }) }) });
    User.findByIdAndUpdate = async (id, change, options) => {
      update = { id, change, options };
      return { notificationEmailEnabled: change.$set.notificationEmailEnabled };
    };

    assert.deepEqual(await service.getPreferences(user), { emailEnabled: false });
    await assert.rejects(service.updatePreferences({ emailEnabled: 'false' }, user), { statusCode: 400 });
    assert.deepEqual(await service.updatePreferences({ emailEnabled: true }, user), { emailEnabled: true });
    assert.equal(update.id.toString(), user.userId);
    assert.deepEqual(update.change, { $set: { notificationEmailEnabled: true } });
    assert.deepEqual(update.options, { new: true });
  } finally {
    User.findById = originalFindById;
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test('disabled optional email still creates an in-app notification', async () => {
  const originalFindById = User.findById;
  const originalCreate = Notification.create;
  let createdNotification;
  emailCalls = 0;

  try {
    User.findById = () => ({ select: () => ({ lean: async () => ({ notificationEmailEnabled: false }) }) });
    Notification.create = async data => {
      createdNotification = { ...data, save: async () => assert.fail('Email state should not be saved') };
      return createdNotification;
    };

    const notification = await service.createNotification({
      type: 'GENERAL', userId, org_id: orgId,
      data: { title: 'A notification', message: 'Hello' },
      sendEmailTo: 'someone@example.com', emailSubject: 'Subject', emailHtml: '<p>Hello</p>'
    });

    assert.equal(notification, createdNotification);
    assert.equal(notification.title, 'A notification');
    assert.equal(notification.emailSent, undefined);
    assert.equal(emailCalls, 0);
  } finally {
    User.findById = originalFindById;
    Notification.create = originalCreate;
  }
});