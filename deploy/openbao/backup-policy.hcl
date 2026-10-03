# Root/operator backup token only; never granted to the API or native executor.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}

# Renew only this periodic service credential; no token creation or root scope.
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/renew-self" {
  capabilities = ["update"]
}
