// backend/scripts/test-ldap-bind.js
//
// Teste isolado: confirma se um usuário comum consegue autenticar
// (bind) contra o Active Directory da Prefeitura via LDAP.
//
// Não faz parte da aplicação ainda — é só validação de que o caminho
// técnico funciona, mesma lógica da PoC (Get-ADComputer/Test-WSMan),
// só que agora testando login de usuário real, não sessão de admin.

require('dotenv').config();
const ldap = require('ldapjs');

const LDAP_URL = process.env.LDAP_URL;
const LDAP_TEST_USER = process.env.LDAP_TEST_USER;
const LDAP_TEST_PASSWORD = process.env.LDAP_TEST_PASSWORD;

if (!LDAP_URL || !LDAP_TEST_USER || !LDAP_TEST_PASSWORD) {
  console.error(
    '❌ Faltam variáveis no .env: LDAP_URL, LDAP_TEST_USER, LDAP_TEST_PASSWORD'
  );
  process.exit(1);
}

const client = ldap.createClient({ url: LDAP_URL });

client.on('error', (err) => {
  console.error('❌ Erro de conexão com o servidor LDAP:', err.message);
});

console.log(`Tentando autenticar como "${LDAP_TEST_USER}" em ${LDAP_URL}...`);

client.bind(LDAP_TEST_USER, LDAP_TEST_PASSWORD, (err) => {
  if (err) {
    console.error('❌ Falha na autenticação:', err.message);
  } else {
    console.log('✅ Autenticação bem-sucedida! O bind LDAP funcionou.');
  }
  client.unbind();
});