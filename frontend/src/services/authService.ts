import type { LoginResponse } from '../types/auth';

const API_URL = import.meta.env.VITE_API_URL ?? '/api';

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Usuário ou senha inválidos.');
    this.name = 'InvalidCredentialsError';
  }
}

export class ServerUnavailableError extends Error {
  constructor() {
    super('Não foi possível conectar ao servidor. Tente novamente em instantes.');
    this.name = 'ServerUnavailableError';
  }
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new ServerUnavailableError();
  }

  if (response.status === 400 || response.status === 401) {
    throw new InvalidCredentialsError();
  }
  if (!response.ok) {
    throw new ServerUnavailableError();
  }

  return (await response.json()) as LoginResponse;
}
