export interface ForeignCanonicalCustomerLinkInput {
  path: string;
  documentId: string;
  uid: string;
  workspaceRootPath: string;
  deleted?: boolean;
}

export function isForeignCanonicalCustomerLink(input: ForeignCanonicalCustomerLinkInput): boolean;
