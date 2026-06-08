/**
 * ServiceTrade API endpoints used by the provider.
 * The provider syncs four entities and normalizes them into platform tables.
 */
module.exports = {
  auth:        "/auth",
  customers:   "/company",                 // ST "company" = end-customer
  jobs:        "/job",                     // appointments embedded inline
  technicians: "/user?isTech=true",
};
