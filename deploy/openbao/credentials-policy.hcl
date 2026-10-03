path "secret/data/openmuse/*" {
  capabilities = ["create", "update", "read"]
}

path "secret/metadata/openmuse/*" {
  capabilities = ["read", "delete"]
}

# Renew only this periodic service credential; no token creation or root scope.
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/renew-self" {
  capabilities = ["update"]
}
