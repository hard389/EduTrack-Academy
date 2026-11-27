/**
 * Return true only for a conflicting canonical school customer registry.
 *
 * EduTrack also uses collectionGroup("customers") for customer-group membership:
 * admins/{adminEmail}/customerGroups/{groupId}/customers/{teacherUid}.
 * Those membership documents are not canonical school registries and must not
 * be mistaken for a teacher linked to a different workspace.
 */
export function isForeignCanonicalCustomerLink({
  path,
  documentId,
  uid,
  workspaceRootPath,
  deleted = false,
}) {
  if (deleted || !path || !documentId || !uid || !workspaceRootPath) return false;
  if (documentId !== uid) return false;

  const segments = String(path).split('/').filter(Boolean);
  const isCanonicalAdminCustomer =
    segments.length === 4 &&
    segments[0] === 'admins' &&
    segments[2] === 'customers' &&
    segments[3] === uid;

  if (!isCanonicalAdminCustomer) return false;
  return path !== `${workspaceRootPath}/customers/${uid}`;
}
