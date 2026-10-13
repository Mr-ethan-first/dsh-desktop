import { Payload } from './host.js'
import type { Payload as SourcePayload } from '@fixture/host'
import type { z } from 'zod'
const precise: z.ZodType<SourcePayload> = Payload
void precise
