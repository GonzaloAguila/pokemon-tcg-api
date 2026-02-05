# Add Module Skill

Use this skill when creating a new feature module for the REST API.

## Module Structure

```
src/modules/<feature>/
├── <feature>.controller.ts   # Express Router with endpoints
├── <feature>.service.ts      # Business logic (pure functions)
├── <feature>.types.ts        # TypeScript interfaces
└── index.ts                  # Barrel exports
```

## Step-by-Step

### 1. Create Types (`<feature>.types.ts`)

```typescript
/**
 * <Feature> module types
 */

export interface FeatureItem {
  id: string;
  name: string;
  // ... other fields
}

export interface CreateFeatureRequest {
  name: string;
  // ... required fields
}

export interface UpdateFeatureRequest {
  name?: string;
  // ... optional fields
}

export interface FeatureListResponse {
  items: FeatureItem[];
  total: number;
}
```

### 2. Create Service (`<feature>.service.ts`)

```typescript
/**
 * <Feature> Service
 *
 * Business logic for <feature>. Keep functions pure when possible.
 */

import type { FeatureItem, CreateFeatureRequest } from "./<feature>.types.js";

// In-memory storage (replace with Prisma later)
const items: Map<string, FeatureItem> = new Map();

/**
 * Get all items
 */
export function getAll(): FeatureItem[] {
  return Array.from(items.values());
}

/**
 * Get item by ID
 */
export function getById(id: string): FeatureItem | undefined {
  return items.get(id);
}

/**
 * Create new item
 */
export function create(data: CreateFeatureRequest): FeatureItem {
  const id = generateId();
  const item: FeatureItem = { id, ...data };
  items.set(id, item);
  return item;
}

/**
 * Update existing item
 */
export function update(id: string, data: Partial<FeatureItem>): FeatureItem {
  const existing = items.get(id);
  if (!existing) throw new Error(`Item '${id}' not found`);

  const updated = { ...existing, ...data, id };
  items.set(id, updated);
  return updated;
}

/**
 * Delete item
 */
export function remove(id: string): boolean {
  return items.delete(id);
}

// Helper
function generateId(): string {
  return Math.random().toString(36).substring(2, 8);
}
```

### 3. Create Controller (`<feature>.controller.ts`)

```typescript
/**
 * <Feature> Controller
 *
 * REST endpoints for <feature> management.
 */

import { Router, type Request, type Response } from "express";
import { AppError } from "../../middleware/error-handler.js";
import * as featureService from "./<feature>.service.js";
import type { CreateFeatureRequest, UpdateFeatureRequest } from "./<feature>.types.js";

const router = Router();

/**
 * GET /api/<features>
 * List all items
 */
router.get("/<features>", (_req: Request, res: Response) => {
  const items = featureService.getAll();
  res.json({ items, total: items.length });
});

/**
 * GET /api/<features>/:id
 * Get single item
 */
router.get("/<features>/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const item = featureService.getById(id);

  if (!item) {
    throw new AppError(`Item '${id}' not found`, 404);
  }

  res.json(item);
});

/**
 * POST /api/<features>
 * Create new item
 */
router.post("/<features>", (req: Request, res: Response) => {
  const data = req.body as CreateFeatureRequest;

  // Validate required fields
  if (!data.name) {
    throw new AppError("Missing required field: name", 400);
  }

  try {
    const item = featureService.create(data);
    res.status(201).json(item);
  } catch (error) {
    throw new AppError((error as Error).message, 400);
  }
});

/**
 * PUT /api/<features>/:id
 * Update existing item
 */
router.put("/<features>/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const data = req.body as UpdateFeatureRequest;

  try {
    const item = featureService.update(id, data);
    res.json(item);
  } catch (error) {
    throw new AppError((error as Error).message, 404);
  }
});

/**
 * DELETE /api/<features>/:id
 * Delete item
 */
router.delete("/<features>/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const deleted = featureService.remove(id);

  if (!deleted) {
    throw new AppError(`Item '${id}' not found`, 404);
  }

  res.status(204).send();
});

export const featureRouter = router;
```

### 4. Create Index (`index.ts`)

```typescript
/**
 * <Feature> module exports
 */

export { featureRouter } from "./<feature>.controller.js";
export * from "./<feature>.service.js";
export * from "./<feature>.types.js";
```

### 5. Register in Main App

Edit `src/index.ts`:

```typescript
import { featureRouter } from "./modules/<feature>/index.js";

// In API Routes section:
app.use("/api", featureRouter);
```

### 6. Update CLAUDE.md

Add the new endpoints to the REST API Reference section.

## Naming Conventions

| Item | Convention | Example |
|------|------------|---------|
| Module folder | singular, kebab-case | `user-profile` |
| Files | `<module>.<type>.ts` | `user-profile.service.ts` |
| Router export | `<feature>Router` | `userProfileRouter` |
| Endpoint path | plural, kebab-case | `/api/user-profiles` |

## Validation Pattern (with Zod)

```typescript
import { z } from "zod";

const CreateFeatureSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
});

// In controller
router.post("/<features>", (req: Request, res: Response) => {
  const result = CreateFeatureSchema.safeParse(req.body);

  if (!result.success) {
    throw new AppError(result.error.issues[0].message, 400);
  }

  const item = featureService.create(result.data);
  res.status(201).json(item);
});
```

## With Database (Prisma)

```typescript
// In service
import { prisma } from "../../lib/prisma.js";

export async function getAll(): Promise<FeatureItem[]> {
  return prisma.feature.findMany();
}

export async function create(data: CreateFeatureRequest): Promise<FeatureItem> {
  return prisma.feature.create({ data });
}
```

## Checklist

- [ ] Create `<feature>.types.ts` with interfaces
- [ ] Create `<feature>.service.ts` with business logic
- [ ] Create `<feature>.controller.ts` with routes
- [ ] Create `index.ts` with exports
- [ ] Register router in `src/index.ts`
- [ ] Update CLAUDE.md with new endpoints
- [ ] Add validation with Zod (optional)
- [ ] Write tests (optional)
