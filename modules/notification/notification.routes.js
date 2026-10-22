"use strict";
const express = require("express");
const router  = express.Router();
const ctrl    = require("./notification.controller");
const pushCtrl = require("./notification.push.controller");
const { authenticate } = require("../../middlewares/auth.middleware");

// ─── In-App Notification Routes ───────────────────────────────────────
router.get("/",              authenticate, ctrl.getMyNotifications);
router.get("/preferences",   authenticate, ctrl.getPreferences);
router.put("/preferences",   authenticate, ctrl.updatePreferences);
router.get("/unread-count",  authenticate, ctrl.getUnreadCount);
router.get("/user/:userId",   authenticate, ctrl.getUserNotifications); // Admin: Get user's notifications
router.patch("/read-all",    authenticate, ctrl.markAllAsRead);
router.patch("/:id/read",    authenticate, ctrl.markAsRead);
router.delete("/:id",        authenticate, ctrl.deleteNotification);

// ─── Push Notification Routes (FCM) ───────────────────────────────────
router.post("/register-token",     authenticate, pushCtrl.registerFCMToken);
router.post("/unregister-token",   authenticate, pushCtrl.unregisterFCMToken);
router.get("/devices",             authenticate, pushCtrl.getMyDevices);
router.post("/test",               authenticate, pushCtrl.testPushNotification);

module.exports = router;