// ─── src/ocr/ocr.controller.ts ───────────────────────────────────────────────

import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Get,
  Param,
  Patch,
  Delete,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { OcrService } from './ocr.service';
import { UpdateOcrDto } from './dto/update-ocr.dto';
import { InvoiceResult } from './ocr.types';

@Controller('ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  async processInvoice(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp|tiff)$/ }),
        ],
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    )
    file: Express.Multer.File,
  ): Promise<InvoiceResult> {
    if (!file?.buffer) {
      throw new BadRequestException('Fichier non reçu ou buffer manquant');
    }
    return this.ocrService.processInvoice(file);
  }

  @Get()
  findAll() {
    return this.ocrService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ocrService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateOcrDto: UpdateOcrDto) {
    return this.ocrService.update(+id, updateOcrDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.ocrService.remove(+id);
  }
}
