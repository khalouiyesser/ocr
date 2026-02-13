import { PartialType } from '@nestjs/mapped-types';
import { CreateOcrDto } from './create-ocr.dto';

export class UpdateOcrDto extends PartialType(CreateOcrDto) {}
