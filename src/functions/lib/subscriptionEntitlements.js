"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasActiveTeacherFeatureEntitlement = hasActiveTeacherFeatureEntitlement;
const firestore_1 = require("firebase-admin/firestore");
const auth_1 = require("firebase-admin/auth");
const LEGACY_PERMISSION_MAP = {
    student_management: 'students.view_assigned',
    class_management: 'classes.view_assigned',
    attendance_management: 'attendance.take_assigned',
    attendance_alerts: 'alerts.manage',
    monthly_reports: 'reports.view_assigned',
    fortnightly_reports: 'reports.view_assigned',
    weekly_reports: 'reports.view_assigned',
    attendance_analytics: 'analytics.view_assigned',
    advanced_analytics: 'analytics.view_all',
    fee_tracking: 'fees.view_assigned',
    fee_alerts: 'fees.alerts',
    custom_alerts: 'alerts.manage',
    quiz_management: 'quiz.view_assigned',
    quiz_result_notifications: 'quiz.manage_assigned',
    notes_library: 'notes.view',
    library_link_whatsapp: 'notes.manage',
    announcements: 'alerts.manage',
};
/**
 * Compatibility export retained for existing Firebase Functions. Teacher feature
 * authorization now comes from verified Academy membership permission grants; SaaS
 * subscription projections, plans and add-ons are deliberately ignored.
 */
async function hasActiveTeacherFeatureEntitlement(tenantId, uid, featureKey) {
    const email = tenantId.trim().toLowerCase();
    const permissionKey = LEGACY_PERMISSION_MAP[featureKey];
    if (!email || !email.includes('@') || email.includes('/') || !uid || !permissionKey)
        return false;
    const db = (0, firestore_1.getFirestore)();
    const userRef = db.collection('users').doc(email);
    const mappingRef = db.collection('academyMemberships').doc(uid);
    const [profileSnapshot, mappingSnapshot] = await Promise.all([userRef.get(), mappingRef.get()]);
    if (!profileSnapshot.exists || !mappingSnapshot.exists)
        return false;
    const profile = profileSnapshot.data() ?? {};
    const mapping = mappingSnapshot.data() ?? {};
    const academyId = typeof mapping.academyId === 'string' ? mapping.academyId : '';
    if (!/^\d{3,15}$/.test(academyId) || Number(academyId) < 100)
        return false;
    const academyRef = db.collection('academies').doc(academyId);
    const memberRef = academyRef.collection('members').doc(uid);
    const [academySnapshot, memberSnapshot, authUser] = await Promise.all([
        academyRef.get(), memberRef.get(), (0, auth_1.getAuth)().getUser(uid).catch(() => null),
    ]);
    if (!academySnapshot.exists || !memberSnapshot.exists || !authUser)
        return false;
    const academy = academySnapshot.data() ?? {};
    const member = memberSnapshot.data() ?? {};
    const profileEmail = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
    if (profile.uid !== uid || profileEmail !== email || profile.role !== 'teacher' || profile.active !== true || profile.disabled === true || profile.deleted === true ||
        authUser.disabled || authUser.emailVerified !== true || (authUser.email ?? '').trim().toLowerCase() !== email ||
        (mapping.uid !== undefined && mapping.uid !== uid) || mapping.academyId !== academyId || typeof mapping.email !== 'string' || mapping.email.trim().toLowerCase() !== email || mapping.role !== 'teacher' || mapping.active !== true || mapping.emailVerified !== true ||
        academy.status !== 'active' || academy.academyId !== academyId ||
        member.uid !== uid || member.academyId !== academyId || member.email !== email || member.role !== 'teacher' || member.active !== true || member.emailVerified !== true)
        return false;
    const permissions = member.permissions && typeof member.permissions === 'object' ? member.permissions : {};
    return permissions[permissionKey] === true;
}
//# sourceMappingURL=subscriptionEntitlements.js.map