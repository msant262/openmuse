ui = false
disable_mlock = false

api_addr = "http://openbao:8200"
cluster_addr = "http://openbao:8201"

storage "raft" {
  path    = "/openbao/data"
  node_id = "openmuse-vps"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_disable     = true
}

seal "static" {
  current_key_id = "openmuse-vps-2026-10"
  current_key    = "file:///openbao/secrets/unseal.key"
}
