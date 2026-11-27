"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshSubscriptionProjections = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_functions_1 = require("firebase-functions");
const subscriptionProjectionRefresh_js_1 = require("./subscriptionProjectionRefresh.js");
exports.refreshSubscriptionProjections = (0, scheduler_1.onSchedule)({
    schedule: 'every 1 minutes',
    region: 'us-central1',
    timeoutSeconds: 540,
    memory: '512MiB',
}, async () => {
    try {
        await (0, subscriptionProjectionRefresh_js_1.refreshDueSubscriptionProjections)();
    }
    catch (error) {
        firebase_functions_1.logger.error('Scheduled subscription projection refresh failed', error);
        throw error;
    }
});
//# sourceMappingURL=subscriptionProjectionScheduler.js.map