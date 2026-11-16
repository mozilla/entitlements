/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  type CollectionReference,
  type DocumentData,
  type Timestamp,
} from '@google-cloud/firestore';

import { UsageGrantNotFoundError } from './metering.error';

// TODO(jpoyourow, 2026-08): converge on the injectable class style used by
// MeteringEventsRepository and MeteringSweepRepository.

export interface UsageGrantRecord {
  id: string;
  subject: string;
  slug: string;
  amount: number;
  grantedBy: string;
  reason?: string;
  createdAt: Timestamp;
  expiresAt: Timestamp | null;
}

export type NewUsageGrant = Omit<UsageGrantRecord, 'id'>;

export async function insertUsageGrant(
  db: CollectionReference,
  data: NewUsageGrant
): Promise<UsageGrantRecord> {
  const ref = await db.add({
    subject: data.subject,
    slug: data.slug,
    amount: data.amount,
    grantedBy: data.grantedBy,
    ...(data.reason !== undefined ? { reason: data.reason } : {}),
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
  });
  return { id: ref.id, ...data };
}

export async function getUsageGrants(
  db: CollectionReference,
  subject: string
): Promise<UsageGrantRecord[]> {
  const result = await db.where('subject', '==', subject).get();
  return result.docs.map((doc) => toUsageGrantRecord(doc.id, doc.data()));
}

export async function deleteUsageGrant(
  db: CollectionReference,
  id: string
): Promise<UsageGrantRecord> {
  const ref = db.doc(id);
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!snapshot.exists || data === undefined) {
    throw new UsageGrantNotFoundError(id);
  }
  await ref.delete();
  return toUsageGrantRecord(id, data);
}

function toUsageGrantRecord(id: string, data: DocumentData): UsageGrantRecord {
  return {
    id,
    subject: data['subject'],
    slug: data['slug'],
    amount: data['amount'],
    grantedBy: data['grantedBy'],
    reason: data['reason'],
    createdAt: data['createdAt'],
    expiresAt: data['expiresAt'] ?? null,
  };
}
