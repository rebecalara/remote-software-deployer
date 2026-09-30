#!/usr/bin/env sh
# Prepara o OpenLDAP LOCAL (container openldap-dev) para o Bloco 2:
#   1. conta de serviço svc-rsd-leitura
#   2. máquinas fictícias em ou=computers
#   3. regra de ACL: leitura só em ou=computers, só para a conta de serviço
#
# Idempotente: pode rodar de novo sem duplicar nada.
# Não usa senha de admin: aplica via ldapi + SASL EXTERNAL como root do container.
# Nunca rodar contra o AD real — só serve para o container de desenvolvimento.
#
# Uso (da raiz do repositório):  sh docker/ldap/setup-dev.sh

set -eu

CONTAINER="${LDAP_CONTAINER:-openldap-dev}"
DIR="$(cd "$(dirname "$0")" && pwd)"
SVC_DN="uid=svc-rsd-leitura,ou=services,dc=rsd,dc=local"

ldap_exec() {
  docker exec -i "$CONTAINER" "$@"
}

add_entries() {
  # -c: continua quando a entrada já existe (código 68), para ser idempotente.
  # O ldapadd imprime "adding new entry" até para as que já existiam, então o
  # resumo é calculado: tentadas - já existentes = criadas.
  out=$(ldap_exec ldapadd -c -Q -Y EXTERNAL -H ldapi:/// < "$DIR/$1" 2>&1 || true)
  tried=$(printf '%s\n' "$out" | grep -c "adding new entry" || true)
  existed=$(printf '%s\n' "$out" | grep -c "Already exists" || true)
  echo "==> $1: $((tried - existed)) criadas, $existed já existiam"
  # Qualquer erro que não seja "já existe" aparece por inteiro
  printf '%s\n' "$out" | grep "^ldap_add:" | grep -v "Already exists" || true
}

add_entries services.dev.ldif
add_entries computers.dev.ldif

echo "==> acl-leitura-computers.ldif"
acl=$(ldap_exec ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "olcDatabase={1}mdb,cn=config" \
  -s base olcAccess -o ldif-wrap=no)
if printf '%s\n' "$acl" | grep -q "$SVC_DN"; then
  echo "regra de ACL já aplicada, nada a fazer"
else
  ldap_exec ldapmodify -Q -Y EXTERNAL -H ldapi:/// < "$DIR/acl-leitura-computers.ldif"
fi

echo "==> pronto. Variáveis para o backend/.env estão em backend/.env.example"
