/**
 * ServiceTrade API endpoints used by the provider.
 * The provider syncs four entities and normalizes them into platform tables.
 */
module.exports = {
  auth:        "/auth",
  customers:   "/company",                 // ST "company" = end-customer
  jobs:        "/job",                     // appointments embedded inline
  technicians: "/user?isTech=true",
  comments:    "/comment",                 // write-back: POST a comment onto an entity
  messages:    "/message",                 // write-back: POST a templated message (e.g. service link)
  contacts:    "/contact",                 // GET (search) + POST (create) recipient contacts
  contactTypes: "/contacttype",            // GET available types + POST a custom type
};
