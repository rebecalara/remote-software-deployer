import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { SoftwareValidationError } from './software-validation';

interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

/** Converte erro de validação do catálogo em 400, indicando o campo com problema. */
@Catch(SoftwareValidationError)
export class SoftwareValidationFilter implements ExceptionFilter {
  catch(error: SoftwareValidationError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<JsonResponse>()
      .status(HttpStatus.BAD_REQUEST)
      .json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: error.message,
        field: error.field,
      });
  }
}
