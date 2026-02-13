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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OcrService } from './ocr.service';
import { UpdateOcrDto } from './dto/update-ocr.dto';
import { log } from 'node:util';

@Controller('ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async processInvoice(@UploadedFile() file: Express.Multer.File) {
    log("11111111111111111111111111111111111111111111111");
    if (!file) throw new Error('Fichier non reçu');
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
  remove(@Param('id') id: string) {
    return this.ocrService.remove(+id);
  }
}
