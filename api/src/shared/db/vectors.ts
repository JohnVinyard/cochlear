/**
 * Vector search: every vector annotation schema gets its own partial HNSW
 * index over `annotations.vector_value`, cast to that schema's dimension.
 * (One untyped `vector` column holds every schema's vectors, and pgvector can
 * only index a fixed dimension, hence one index per schema.)
 *
 * The index's expression and predicate must match the query's *exactly* for
 * the planner to use it, so both are built here. Schema ids and dimensions
 * come from the database, not from requests, and are checked to be integers
 * before being written into SQL.
 *
 * Distance is cosine, for every schema, for now.
 */

const int = (n: number, what: string): number => {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${what} must be a positive integer, not ${n}`);
    return n;
};

export const vectorIndexName = (schemaId: number) => `annotations_vector_${int(schemaId, 'schema id')}`;

/** The indexed expression: `a.` prefixes the column for queries that alias `annotations` */
export const vectorExpression = (dim: number, alias = '') => `(${alias}vector_value::vector(${int(dim, 'vector_dim')}))`;

/** The index's predicate; queries must include it verbatim */
export const vectorPredicate = (schemaId: number, alias = '') => `${alias}schema_id = ${int(schemaId, 'schema id')}`;

export const createVectorIndex = (schemaId: number, dim: number) =>
    `create index concurrently if not exists ${vectorIndexName(schemaId)}
     on annotations using hnsw (${vectorExpression(dim)} vector_cosine_ops)
     where ${vectorPredicate(schemaId)}`;

/** pgvector's cosine distance operator, between the indexed expression and a parameter */
export const cosineDistance = (dim: number, param: string, alias = '') =>
    `${vectorExpression(dim, alias)} <=> ${param}::vector(${int(dim, 'vector_dim')})`;
