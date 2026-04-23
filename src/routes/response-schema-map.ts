/**
 * @file Route→schema maps consumed by `validate-response` middleware.
 *
 * Keyed by Express's router-relative `${method} ${route.path}` format
 * (method lowercase, path matches what Express stores in `req.route.path`).
 * When a new route is added, add a corresponding entry here; the
 * validator is a no-op for routes not in the map (so new routes
 * ship without a hard dependency on a schema existing yet).
 */

import {
  IngestResponseSchema,
  SearchResponseSchema,
  ExpandResponseSchema,
  ListResponseSchema,
  GetMemoryResponseSchema,
  StatsResponseSchema,
  HealthResponseSchema,
  ConfigUpdateResponseSchema,
  ConsolidateResponseSchema,
  DecayResponseSchema,
  CapResponseSchema,
  LessonsListResponseSchema,
  LessonStatsResponseSchema,
  LessonReportResponseSchema,
  ReconciliationResponseSchema,
  ReconcileStatusResponseSchema,
  ResetSourceResponseSchema,
  SuccessResponseSchema,
  MutationSummaryResponseSchema,
  AuditRecentResponseSchema,
  AuditTrailResponseSchema,
  TrustResponseSchema,
  ConflictsListResponseSchema,
  ResolveConflictResponseSchema,
  AutoResolveConflictsResponseSchema,
} from '../schemas/responses.js';
import type { ResponseSchemaMap } from '../middleware/validate-response.js';

export const MEMORY_RESPONSE_SCHEMAS: ResponseSchemaMap = {
  'post /ingest': IngestResponseSchema,
  'post /ingest/quick': IngestResponseSchema,
  'post /search': SearchResponseSchema,
  'post /search/fast': SearchResponseSchema,
  'post /expand': ExpandResponseSchema,
  'get /list': ListResponseSchema,
  'get /stats': StatsResponseSchema,
  'get /health': HealthResponseSchema,
  'put /config': ConfigUpdateResponseSchema,
  'post /consolidate': ConsolidateResponseSchema,
  'post /decay': DecayResponseSchema,
  'get /cap': CapResponseSchema,
  'get /lessons': LessonsListResponseSchema,
  'get /lessons/stats': LessonStatsResponseSchema,
  'post /lessons/report': LessonReportResponseSchema,
  'delete /lessons/:id': SuccessResponseSchema,
  'post /reconcile': ReconciliationResponseSchema,
  'get /reconcile/status': ReconcileStatusResponseSchema,
  'post /reset-source': ResetSourceResponseSchema,
  'get /:id': GetMemoryResponseSchema,
  'delete /:id': SuccessResponseSchema,
  'get /audit/summary': MutationSummaryResponseSchema,
  'get /audit/recent': AuditRecentResponseSchema,
  'get /:id/audit': AuditTrailResponseSchema,
};

export const AGENT_RESPONSE_SCHEMAS: ResponseSchemaMap = {
  'put /trust': TrustResponseSchema,
  'get /trust': TrustResponseSchema,
  'get /conflicts': ConflictsListResponseSchema,
  'put /conflicts/:id/resolve': ResolveConflictResponseSchema,
  'post /conflicts/auto-resolve': AutoResolveConflictsResponseSchema,
};
