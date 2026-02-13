import { IsArray, IsOptional, IsString } from 'class-validator';

// ✅ Permission exportée avec la bonne structure
export interface Permission {
  resource: string;
  actions: string[];
}

export class CreateRoleDto {
  @IsString()
  name: string;

  @IsArray()
  @IsOptional()
  permissions?: Permission[];
}
