/** Pure validation helpers shared by Academy identity services and tests. */
export const normalizeAcademyEmail = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

export const isAllowedAcademyEmail = (value) => {
  const email = normalizeAcademyEmail(value);
  return email.length <= 254 && /^[a-z0-9._%+-]+@gmail\.com$/.test(email);
};

export const normalizeAcademyId = (value) => {
  const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{3,15}$/.test(id)) return '';
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) && numeric >= 100 ? String(numeric) : '';
};

export const nextAcademyIdFromCounter = (counterData) => {
  if (counterData == null) return 100;
  const nextId = counterData.nextId;
  if (!Number.isSafeInteger(nextId) || nextId < 100) {
    throw new Error('The Academy ID counter is invalid. Contact the platform administrator.');
  }
  return nextId;
};

export const isStrongAcademyPassword = (value) =>
  typeof value === 'string' && value.length >= 6 && value.length <= 128 && /[A-Z]/.test(value) && /[^A-Za-z0-9]/.test(value);

export const isAcademyRole = (value) => value === 'academy_admin' || value === 'teacher';

export const isActiveAcademyMembership = ({
  academy,
  membership,
  mapping,
  uid,
  email,
  role,
}) => {
  const normalizedEmail = normalizeAcademyEmail(email);
  return Boolean(
    academy && membership && mapping &&
    typeof uid === 'string' && uid.length > 0 &&
    normalizedEmail &&
    normalizeAcademyId(mapping.academyId) &&
    String(mapping.academyId) === String(membership.academyId) &&
    String(membership.uid) === uid &&
    normalizeAcademyEmail(membership.email) === normalizedEmail &&
    normalizeAcademyEmail(mapping.email) === normalizedEmail &&
    isAcademyRole(membership.role) && membership.role === role &&
    mapping.role === role &&
    mapping.active === true && membership.active === true &&
    membership.emailVerified === true &&
    academy.status === 'active' &&
    String(academy.academyId) === String(mapping.academyId)
  );
};
