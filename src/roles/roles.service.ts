import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { CreateRoleDto, Permission } from './dtos/role.dto';

export interface RoleRecord {
  _id: string;
  name: string;
  permissions: Permission[]; // ✅ Permission[] au lieu de string[]
}

@Injectable()
export class RolesService {
  private roles: RoleRecord[] = [
    {
      _id: 'default-role-id',
      name: 'user',
      permissions: [{ resource: 'invoice', actions: ['read'] }],
    },
    {
      _id: 'admin-role-id',
      name: 'admin',
      permissions: [
        { resource: 'invoice', actions: ['read', 'write', 'delete'] },
      ],
    },
  ];

  async createRole(dto: CreateRoleDto): Promise<RoleRecord> {
    const exists = this.roles.find(
      (r) => r.name.toLowerCase() === dto.name.toLowerCase(),
    );
    if (exists) throw new BadRequestException('Role already exists');

    const newRole: RoleRecord = {
      _id: uuidv4(),
      name: dto.name,
      permissions: dto.permissions ?? [],
    };
    this.roles.push(newRole);
    return newRole;
  }

  async getRoleById(roleId: string): Promise<RoleRecord> {
    const role = this.roles.find((r) => r._id === roleId);
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    return role;
  }
}
