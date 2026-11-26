/**
 * PRIMEIRO import do main.ts. Carrega o .env (o DOTENV_CONFIG_PATH do serviço aponta para o
 * C:\rsd\config\backend.env) e, só se houver chave, o agente New Relic — que precisa entrar antes
 * do Express, do Prisma e do ldapjs para instrumentá-los. Por isso não é "-r newrelic" no WinSW:
 * ali o agente carregaria antes do dotenv e não acharia a chave.
 */
import 'dotenv/config';
import { startNewRelic } from './newrelic-loader';

startNewRelic();
