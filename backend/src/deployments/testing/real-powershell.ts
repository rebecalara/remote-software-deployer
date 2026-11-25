/**
 * Tempo limite dos testes que chamam o powershell.exe DE VERDADE (sem tocar em nenhuma
 * máquina). Cada um inicia um processo do Windows PowerShell 5.1, que leva ~0,5 s parado e
 * bem mais com a suíte inteira rodando em paralelo — no padrão do Jest (5 s) eles esgotavam
 * o tempo de vez em quando. Só esses testes usam este valor; o padrão global não muda.
 */
export const REAL_POWERSHELL_TEST_TIMEOUT_MS = 60_000;
